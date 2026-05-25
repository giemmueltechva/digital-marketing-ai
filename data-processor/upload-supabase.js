require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const OUTPUT_DIR = process.env.OUTPUT_DIR || './output_data';

async function uploadToSupabase() {
  const files = fs.readdirSync(OUTPUT_DIR).filter(file => file.endsWith('.json'));

  for (const file of files) {
    const filePath = path.join(OUTPUT_DIR, file);
    const rawData = fs.readFileSync(filePath);
    const data = JSON.parse(rawData);

    // Combine transcript and frame descriptions into a single cohesive Markdown doc
    const titleClean = data.videoTitle.replace('.mp4', '');
    const markdownContent = `
# Lesson: ${titleClean}

## Transcript
${data.transcript}

## Slide & Visual Descriptions
${data.visualDescriptions.map(vd => `### Slide (${vd.frame})\n${vd.description}`).join('\n\n')}
    `.trim();

    console.log(`Uploading ${data.videoTitle}...`);

    // Insert or update based on video title matching
    const { data: insertedData, error } = await supabase
      .from('video_contents')
      .upsert(
        { video_title: titleClean, combined_markdown: markdownContent },
        { onConflict: 'video_title' }
      );

    if (error) {
      console.error(`Error uploading ${data.videoTitle}:`, error.message);
    } else {
      console.log(`Uploaded successfully: ${data.videoTitle}`);
    }
  }
}

uploadToSupabase().catch(console.error);
