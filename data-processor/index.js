require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
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
            .audioBitrate('64k')
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
const transcribeAudio = async (audioPath) => {
    console.log(`Transcribing audio: ${path.basename(audioPath)}...`);
    try {
        const transcription = await groq.audio.transcriptions.create({
            file: fs.createReadStream(audioPath),
            model: 'whisper-large-v3',
            response_format: 'verbose_json',
        });
        console.log('Transcription complete.');
        return transcription.text;
    } catch (error) {
        console.error('Error transcribing audio:', error);
        return null;
    }
};

/**
 * Extract keyframes from video (e.g., 1 frame every 60 seconds)
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
        const chatCompletion = await groq.chat.completions.create({
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
        if (error.status === 429 && retryCount < 3) {
            let retryAfterSec = 15;
            if (error.headers) {
                if (typeof error.headers.get === 'function') {
                    retryAfterSec = parseInt(error.headers.get('retry-after') || '15', 10);
                } else {
                    retryAfterSec = parseInt(error.headers['retry-after'] || '15', 10);
                }
            }
            
            // Cap retry delay to 5 minutes to avoid hanging indefinitely
            if (retryAfterSec > 300) {
                console.warn(`Rate limit retry delay is too long (${retryAfterSec}s). Capping it to 300 seconds.`);
                retryAfterSec = 300;
            }
            
            console.warn(`Rate limit hit (429) for ${path.basename(imagePath)}. Waiting for ${retryAfterSec} seconds before retrying (Attempt ${retryCount + 1}/3)...`);
            await sleep(retryAfterSec * 1000);
            return describeFrame(imagePath, retryCount + 1);
        }
        console.error(`Error describing frame ${path.basename(imagePath)}:`, error.message);
        return null;
    }
};

/**
 * Main processing loop
 */
const processVideos = async () => {
    const files = fs.readdirSync(INPUT_DIR).filter(file => file.match(/\.(mp4|mkv|avi|mov)$/i));
    
    if (files.length === 0) {
        console.log(`No videos found in ${INPUT_DIR}. Please add your videos and run the script again.`);
        return;
    }

    console.log(`Found ${files.length} video(s) to process.`);

    for (const file of files) {
        const videoPath = path.join(INPUT_DIR, file);
        const baseName = path.parse(file).name;
        const resultPath = path.join(OUTPUT_DIR, `${baseName}.json`);
        
        if (fs.existsSync(resultPath)) {
            console.log(`Skipping ${file}, already processed.`);
            continue;
        }

        console.log(`\n--- Processing Video: ${file} ---`);
        
        // 1. Audio Extraction
        const audioPath = path.join(TEMP_DIR, `${baseName}.mp3`);
        await extractAudio(videoPath, audioPath);
        
        // 2. Transcription
        const transcript = await transcribeAudio(audioPath);
        if (!transcript) {
            console.error(`Transcription failed for ${file}. Skipping this video to prevent saving incomplete JSON and deleting source file.`);
            try { fs.unlinkSync(audioPath); } catch (_) {}
            continue;
        }
        
        // 3. Frame Extraction & Vision Processing
        const visualDescriptions = [];
        if (process.env.DISABLE_VISION === 'true') {
            console.log('Vision processing is disabled (DISABLE_VISION=true). Skipping frame extraction and slide descriptions.');
        } else {
            const framesFolder = path.join(TEMP_DIR, `${baseName}_frames`);
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
            
            // If we extracted frames but couldn't describe ANY of them, abort to prevent deleting the video.
            if (framePaths.length > 0 && visualDescriptions.length === 0) {
                console.error(`Error: Could not describe any of the ${framePaths.length} extracted frames for ${file} due to vision API failures. Skipping to prevent saving incomplete JSON and deleting video.`);
                try { fs.rmSync(framesFolder, { recursive: true, force: true }); } catch (_) {}
                continue;
            }
            
            // Clean up frame images folder
            try { fs.rmSync(framesFolder, { recursive: true, force: true }); } catch (_) {}
        }
        
        // 5. Compile and Save Result
        const finalData = {
            videoTitle: file,
            transcript: transcript,
            visualDescriptions: visualDescriptions,
            processedAt: new Date().toISOString()
        };
        
        fs.writeFileSync(resultPath, JSON.stringify(finalData, null, 2));
        console.log(`Saved results for ${file} to ${resultPath}`);
        
        // Optional: Cleanup temp files to save space
        try { fs.unlinkSync(audioPath); } catch (_) {}
        if (process.env.DISABLE_VISION !== 'true') {
            try { fs.rmSync(framesFolder, { recursive: true, force: true }); } catch (_) {}
        }
        
        // Delete original video file to free up local disk space
        try {
            fs.unlinkSync(videoPath);
            console.log(`Deleted original video file: ${file}`);
        } catch (err) {
            console.error(`Failed to delete original video ${file}:`, err);
        }
    }
    
    console.log('\nAll videos processed successfully!');
};

processVideos().catch(console.error);
