require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');

const API_KEYS = [
  process.env.GROQ_API_KEY,
  ...(process.env.GROQ_RESERVE_API_KEY || '').split(',').map(k => k.trim())
].filter(Boolean);

let currentKeyIndex = 0;

const getGroqClient = () => {
  return new Groq({ apiKey: API_KEYS[currentKeyIndex] });
};

const swapKeysInEnvFile = () => {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  
  try {
    const primaryKey = process.env.GROQ_API_KEY || '';
    const reserveKeysStr = process.env.GROQ_RESERVE_API_KEY || '';
    const reserveKeys = reserveKeysStr.split(',').map(k => k.trim()).filter(Boolean);
    
    if (reserveKeys.length === 0) {
      console.warn('Reserve API key list is empty. Cannot swap keys.');
      return;
    }

    const nextPrimaryKey = reserveKeys[0];
    const remainingReserveKeysStr = reserveKeys.slice(1).join(',');

    console.log(`\n>>> Rate limit hit! Swapping GROQ_API_KEY with the next reserve key in .env... <<<`);

    let envContent = fs.readFileSync(envPath, 'utf8');

    // Update GROQ_API_KEY to the next reserve key
    envContent = envContent.replace(
      /GROQ_API_KEY\s*=\s*[^\r\n]*/,
      `GROQ_API_KEY=${nextPrimaryKey}`
    );

    // Update GROQ_RESERVE_API_KEY with the remaining keys
    envContent = envContent.replace(
      /GROQ_RESERVE_API_KEY\s*=\s*[^\r\n]*/,
      `GROQ_RESERVE_API_KEY=${remainingReserveKeysStr}`
    );

    fs.writeFileSync(envPath, envContent, 'utf8');
    
    // Update active memory
    process.env.GROQ_API_KEY = nextPrimaryKey;
    process.env.GROQ_RESERVE_API_KEY = remainingReserveKeysStr;
    
    // Update local key tracking list
    API_KEYS[0] = nextPrimaryKey;
    API_KEYS.splice(1);
    reserveKeys.slice(1).forEach(k => API_KEYS.push(k));
    currentKeyIndex = 0;
    
    console.log(`>>> .env file updated successfully. Remaining reserve keys: ${remainingReserveKeysStr || 'None'} <<<\n`);
  } catch (err) {
    console.error('Error swapping keys in .env:', err.message);
  }
};

const rotateApiKey = () => {
  if (API_KEYS.length > 1 && process.env.GROQ_RESERVE_API_KEY) {
    swapKeysInEnvFile();
  } else {
    console.log('No reserve API key available to swap. Continuing with current key.');
  }
};

const isRateLimitError = (error) => {
  if (error.status === 429 || error.status === 413) return true;
  if (error.error && error.error.error && error.error.error.code === 'rate_limit_exceeded') return true;
  if (error.message && error.message.toLowerCase().includes('rate_limit')) return true;
  return false;
};

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const INPUT_DIR = process.env.VIDEO_INPUT_DIR || './input_videos';
const OUTPUT_DIR = process.env.OUTPUT_DIR || './output_data';
const TEMP_DIR = './temp';

// Create directories if they don't exist
[INPUT_DIR, OUTPUT_DIR, TEMP_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Helper function to wait
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Extract audio from a video file
 */
const extractAudio = (videoPath, outputPath) => {
    return new Promise((resolve, reject) => {
        console.log(`Extracting audio from ${path.basename(videoPath)}...`);
        ffmpeg(videoPath)
            .output(outputPath)
            .noVideo()
            .audioCodec('libmp3lame')
            .audioChannels(1)
            .audioFrequency(16000)
            .audioBitrate('16k')
            .on('end', () => {
                console.log('Audio extraction complete.');
                resolve(outputPath);
            })
            .on('error', (err) => {
                console.error('Error extracting audio:', err);
                reject(err);
            })
            .run();
    });
};

/**
 * Transcribe audio using Groq Whisper API
 */
const transcribeAudio = async (audioPath, retryCount = 0) => {
    console.log(`Transcribing audio: ${path.basename(audioPath)}...`);
    try {
        const groqClient = getGroqClient();
        const transcription = await groqClient.audio.transcriptions.create({
            file: fs.createReadStream(audioPath),
            model: 'whisper-large-v3',
            response_format: 'verbose_json',
        });
        console.log('Transcription complete.');
        return transcription.text;
    } catch (error) {
        if (isRateLimitError(error)) {
            if (retryCount < API_KEYS.length - 1) {
                console.warn(`Rate limit / ASPH hit during transcription. Rotating API key and retrying immediately...`);
                rotateApiKey();
                return transcribeAudio(audioPath, retryCount + 1);
            }
            
            let retryAfterSec = 15;
            if (error.headers) {
                if (typeof error.headers.get === 'function') {
                    retryAfterSec = parseInt(error.headers.get('retry-after') || '15', 10);
                } else {
                    retryAfterSec = parseInt(error.headers['retry-after'] || '15', 10);
                }
            }
            if (retryAfterSec > 300) {
                retryAfterSec = 300;
            }
            console.warn(`All Groq API keys rate limited during transcription. Waiting for ${retryAfterSec} seconds before retrying...`);
            await sleep(retryAfterSec * 1000);
            rotateApiKey();
            return transcribeAudio(audioPath, retryCount + 1);
        }
        console.error('Error transcribing audio:', error);
        return null;
    }
};

/**
 * Extract keyframes from video (e.g., 1 frame every 120 seconds)
 */
const extractFrames = (videoPath, outputFolder) => {
    return new Promise((resolve, reject) => {
        console.log(`Extracting frames from ${path.basename(videoPath)}...`);
        if (!fs.existsSync(outputFolder)) fs.mkdirSync(outputFolder, { recursive: true });
        
        ffmpeg(videoPath)
            .outputOptions('-vf', 'fps=1/120')
            .output(path.join(outputFolder, 'frame-%d.jpg'))
            .on('end', () => {
                console.log('Frame extraction complete.');
                const frames = fs.readdirSync(outputFolder).filter(f => f.endsWith('.jpg')).map(f => path.join(outputFolder, f));
                resolve(frames);
            })
            .on('error', (err) => {
                console.error('Error extracting frames:', err);
                reject(err);
            })
            .run();
    });
};

/**
 * Encode an image file to a base64 string
 */
const encodeImage = (imagePath) => {
    const file = fs.readFileSync(imagePath);
    return Buffer.from(file).toString('base64');
};

/**
 * Describe a frame using Groq Vision API
 */
const describeFrame = async (imagePath, retryCount = 0) => {
    console.log(`Describing frame: ${path.basename(imagePath)}...`);
    try {
        const base64Image = encodeImage(imagePath);
        const groqClient = getGroqClient();
        const chatCompletion = await groqClient.chat.completions.create({
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Describe the key information, diagrams, or text shown in this presentation slide or video frame. Keep it concise but detailed enough for a student studying the material.' },
                        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
                    ]
                }
            ],
            model: 'meta-llama/llama-4-scout-17b-16e-instruct',
            max_tokens: 1024,
        });
        return chatCompletion.choices[0].message.content;
    } catch (error) {
        if (isRateLimitError(error)) {
            if (retryCount < API_KEYS.length - 1) {
                console.warn(`Rate limit / ASPH hit for ${path.basename(imagePath)}. Rotating API key and retrying immediately...`);
                rotateApiKey();
                return describeFrame(imagePath, retryCount + 1);
            }
            
            let retryAfterSec = 15;
            if (error.headers) {
                if (typeof error.headers.get === 'function') {
                    retryAfterSec = parseInt(error.headers.get('retry-after') || '15', 10);
                } else {
                    retryAfterSec = parseInt(error.headers['retry-after'] || '15', 10);
                }
            }
            if (retryAfterSec > 300) {
                console.warn(`Rate limit retry delay is too long (${retryAfterSec}s). Capping it to 300 seconds.`);
                retryAfterSec = 300;
            }
            console.warn(`All Groq API keys rate limited. Waiting for ${retryAfterSec} seconds before retrying (Attempt ${retryCount + 1})...`);
            await sleep(retryAfterSec * 1000);
            rotateApiKey();
            return describeFrame(imagePath, retryCount + 1);
        }
        console.error(`Error describing frame ${path.basename(imagePath)}:`, error.message);
        return null;
    }
};

/**
 * Upload JSON data to Supabase
 */
async function uploadDataToSupabase(data) {
    const titleClean = data.videoTitle.replace('.mp4', '');
    const markdownContent = `
# Lesson: ${titleClean}

## Transcript
${data.transcript}

## Slide & Visual Descriptions
${data.visualDescriptions.map(vd => `### Slide (${vd.frame})\n${vd.description}`).join('\n\n')}
    `.trim();

    console.log(`Uploading ${data.videoTitle} to Supabase...`);

    const { data: insertedData, error } = await supabase
      .from('video_contents')
      .upsert(
        { video_title: titleClean, combined_markdown: markdownContent },
        { onConflict: 'video_title' }
      );

    if (error) {
      console.error(`Error uploading ${data.videoTitle}:`, error.message);
      return false;
    } else {
      console.log(`Uploaded successfully: ${data.videoTitle}`);
      return true;
    }
}

/**
 * Process a single video file
 */
const processSingleVideo = async (file) => {
    const videoPath = path.join(INPUT_DIR, file);
    const baseName = path.parse(file).name;
    const resultPath = path.join(OUTPUT_DIR, `${baseName}.json`);

    let finalData;

    if (fs.existsSync(resultPath)) {
        console.log(`JSON result already exists for ${file}. Reading from cache.`);
        try {
            finalData = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
        } catch (err) {
            console.error(`Error reading existing JSON for ${file}:`, err.message);
        }
    }

    if (!finalData) {
        console.log(`\n--- Processing Video: ${file} ---`);
        
        // 1. Audio Extraction
        const audioPath = path.join(TEMP_DIR, `${baseName}.mp3`);
        await extractAudio(videoPath, audioPath);
        
        // 2. Transcription
        const transcript = await transcribeAudio(audioPath);
        if (!transcript) {
            console.error(`Transcription failed for ${file}. Skipping.`);
            try { fs.unlinkSync(audioPath); } catch (_) {}
            return false;
        }
        
        // 3. Frame Extraction & Vision Processing
        const visualDescriptions = [];
        const framesFolder = path.join(TEMP_DIR, `${baseName}_frames`);
        
        if (process.env.DISABLE_VISION === 'true') {
            console.log('Vision processing is disabled (DISABLE_VISION=true). Skipping frame extraction.');
        } else {
            const framePaths = await extractFrames(videoPath, framesFolder);
            
            for (const framePath of framePaths) {
                const description = await describeFrame(framePath);
                if (description) {
                    visualDescriptions.push({
                        frame: path.basename(framePath),
                        description: description
                    });
                }
            }
            
            if (framePaths.length > 0 && visualDescriptions.length === 0) {
                console.error(`Error: Could not describe any frames for ${file}. Skipping.`);
                try { fs.rmSync(framesFolder, { recursive: true, force: true }); } catch (_) {}
                try { fs.unlinkSync(audioPath); } catch (_) {}
                return false;
            }
        }
        
        // 4. Compile and Save Result
        finalData = {
            videoTitle: file,
            transcript: transcript,
            visualDescriptions: visualDescriptions,
            processedAt: new Date().toISOString()
        };
        
        fs.writeFileSync(resultPath, JSON.stringify(finalData, null, 2));
        console.log(`Saved results for ${file} to ${resultPath}`);
        
        // Cleanup temp files
        try { fs.unlinkSync(audioPath); } catch (_) {}
        try { fs.rmSync(framesFolder, { recursive: true, force: true }); } catch (_) {}
    }

    // Now upload to Supabase
    const uploadSuccess = await uploadDataToSupabase(finalData);

    if (uploadSuccess) {
        // Only delete original video file after successful upload to Supabase
        try {
            if (fs.existsSync(videoPath)) {
                fs.unlinkSync(videoPath);
                console.log(`Deleted original video file: ${file}`);
            } else {
                console.log(`Original video file ${file} was already deleted or not found.`);
            }
            return true;
        } catch (err) {
            console.error(`Failed to delete original video ${file}:`, err.message);
            return true;
        }
    } else {
        console.error(`Supabase upload failed for ${file}. Retaining video file for retry.`);
        return false;
    }
};

/**
 * Main pipeline
 */
const main = async () => {
    // 1. Process and upload any video files in the input folder
    const files = fs.readdirSync(INPUT_DIR).filter(file => file.match(/\.(mp4|mkv|avi|mov)$/i));
    
    if (files.length > 0) {
        console.log(`Found ${files.length} video(s) to process.`);
        for (const file of files) {
            try {
                await processSingleVideo(file);
            } catch (err) {
                console.error(`Error processing video ${file}:`, err);
            }
        }
    } else {
        console.log(`No videos found in ${INPUT_DIR} to process.`);
    }

    // 2. Perform a final sweep to upload all JSON files in the output directory
    console.log('\nPerforming a final sweep to upload all JSON files in output_data to Supabase...');
    const jsonFiles = fs.readdirSync(OUTPUT_DIR).filter(file => file.endsWith('.json'));
    console.log(`Found ${jsonFiles.length} JSON files in output_data.`);
    
    for (const file of jsonFiles) {
        const filePath = path.join(OUTPUT_DIR, file);
        try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            await uploadDataToSupabase(data);
        } catch (err) {
            console.error(`Error uploading JSON file ${file}:`, err.message);
        }
    }
    
    console.log('\nPipeline run finished successfully!');
};

main().catch(console.error);
