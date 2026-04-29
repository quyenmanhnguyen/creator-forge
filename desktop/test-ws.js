/**
 * Quick test: Trigger 1 image generation and dump WS + save results
 */
const path = require('path');
const fs = require('fs');

// Load config
const { PATHS } = require('./src/config/app.config');
const ImageService = require('./src/services/ImageService');
const AuthService = require('./src/services/AuthService');

const outputDir = path.join(__dirname, '..', '..', 'images', 'ws_test_' + Date.now());
fs.mkdirSync(outputDir, { recursive: true });

console.log('Output dir:', outputDir);
console.log('PATHS.IMAGE_DIR:', PATHS.IMAGE_DIR);

async function main() {
    // Get first active session
    const sessions = AuthService.getAllSessions();
    if (sessions.length === 0) {
        console.log('ERROR: No active sessions. Login first via the app UI.');
        process.exit(1);
    }

    const session = sessions[0];
    console.log('Using session for account index:', session.accIdx);
    console.log('Has _page?', !!session._page);

    if (!session._page) {
        console.log('ERROR: No browser page in session. Login via app UI first.');
        process.exit(1);
    }

    const prompt = 'a beautiful sunset over calm ocean, golden hour, photorealistic, 8k --ar 1:1';
    const config = {
        imageGenerationCount: 4,
        outputFolder: outputDir,
    };

    console.log('\n=== Testing generateOne ===');
    try {
        const result = await ImageService.generateOne(prompt, session, config);
        console.log('\n=== RESULT ===');
        console.log('title:', result.title);
        console.log('imageBase64 count:', (result.imageBase64 || []).length);
        console.log('imageUrls count:', (result.imageUrls || []).length);
        console.log('error:', result.error);
        
        if ((result.imageBase64 || []).length > 0) {
            for (let i = 0; i < result.imageBase64.length; i++) {
                const img = result.imageBase64[i];
                const dataLen = (img.data || '').length;
                const sizeEstimate = Math.floor(dataLen * 3 / 4);
                console.log(`  base64[${i}]: imageIndex=${img.imageIndex}, dataLen=${dataLen}, ~${sizeEstimate} bytes`);
                
                // Try saving manually
                try {
                    let base64Data = img.data;
                    let ext = 'jpg';
                    if (base64Data.startsWith('data:image/')) {
                        const match = base64Data.match(/^data:image\/(png|jpeg|jpg|webp);base64,/);
                        if (match) {
                            ext = match[1] === 'jpeg' ? 'jpg' : match[1];
                            base64Data = base64Data.substring(match[0].length);
                        }
                    }
                    const buffer = Buffer.from(base64Data, 'base64');
                    const filename = `ws_test_i${i}.${ext}`;
                    const filePath = path.join(outputDir, filename);
                    fs.writeFileSync(filePath, buffer);
                    console.log(`  SAVED: ${filePath} (${buffer.length} bytes)`);
                } catch (e) {
                    console.log(`  SAVE ERROR: ${e.message}`);
                }
            }
        }
    } catch (err) {
        console.error('generateOne ERROR:', err.message);
        console.error(err.stack);
    }

    console.log('\nDone. Check output dir:', outputDir);
}

main().catch(console.error);
