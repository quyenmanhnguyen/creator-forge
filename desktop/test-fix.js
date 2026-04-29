/**
 * Quick test for the ImageService fix
 * Tests: generateViaBrowser with cardAttachment parsing + race download
 */
const ImageService = require('./src/services/ImageService');
const AuthService = require('./src/services/AuthService');
const path = require('path');
const fs = require('fs');

const outputDir = path.join(__dirname, '..', '..', 'images', 'test_fix_' + Date.now());

async function main() {
    console.log('=== ImageService Fix Test ===');
    console.log('Output dir:', outputDir);
    
    // Ensure output dir exists
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    
    // Get active session
    const sessions = Array.from(AuthService.activeSessions.values());
    if (sessions.length === 0) {
        console.error('❌ No active sessions. Please login via the app first.');
        process.exit(1);
    }
    
    const session = sessions[0];
    console.log('Using session:', session.email);
    console.log('Has browser page:', !!session._page);
    
    // Simple test prompt (non-moderated content to verify basic flow)
    const testPrompt = 'a beautiful sunset over a calm ocean, golden hour, photorealistic, 8k';
    
    console.log('\n--- Test 1: generateOne (should use browser gen if page available) ---');
    console.log('Prompt:', testPrompt);
    
    try {
        const result = await ImageService.generateOne(testPrompt, session, {
            outputFolder: outputDir,
        });
        
        console.log('\n--- Result ---');
        console.log('Title:', result.title);
        console.log('Image URLs:', result.imageUrls?.length || 0);
        console.log('Image Base64:', result.imageBase64?.length || 0);
        console.log('Error:', result.error || 'none');
        
        if (result.imageBase64?.length > 0) {
            for (const img of result.imageBase64) {
                console.log(`  Base64 image: idx=${img.imageIndex}, size=${img.size} bytes`);
                
                // Save it
                let data = img.data;
                let ext = 'jpg';
                if (data.startsWith('data:image/')) {
                    const match = data.match(/^data:image\/(png|jpeg|jpg|webp);base64,/);
                    if (match) {
                        ext = match[1] === 'jpeg' ? 'jpg' : match[1];
                        data = data.substring(match[0].length);
                    }
                }
                const buffer = Buffer.from(data, 'base64');
                const filePath = path.join(outputDir, `test_base64_i${img.imageIndex}.${ext}`);
                fs.writeFileSync(filePath, buffer);
                console.log(`  ✅ Saved: ${filePath} (${buffer.length} bytes)`);
            }
        }
        
        if (result.imageUrls?.length > 0) {
            console.log('\nImage URLs found:');
            for (const u of result.imageUrls) {
                console.log(`  URL: ${u.imageUrl.substring(u.imageUrl.indexOf('generated') || 0)}`);
                
                // Try downloading
                const dl = await ImageService.downloadImage(u.imageUrl, session);
                if (dl) {
                    const ext = dl.contentType?.includes('png') ? 'png' : 'jpg';
                    const filePath = path.join(outputDir, `test_url_i${u.imageIndex}.${ext}`);
                    fs.writeFileSync(filePath, dl.data);
                    console.log(`  ✅ Downloaded: ${filePath} (${dl.size} bytes)`);
                } else {
                    console.log(`  ❌ Download failed`);
                }
            }
        }
        
        // List saved files
        const files = fs.readdirSync(outputDir);
        console.log('\n--- Saved files ---');
        for (const f of files) {
            const stat = fs.statSync(path.join(outputDir, f));
            const sizeKB = (stat.size / 1024).toFixed(1);
            const quality = stat.size > 50000 ? '✅ GOOD' : stat.size > 10000 ? '⚠️ SMALL' : '❌ BLURRED';
            console.log(`  ${f}: ${sizeKB}KB ${quality}`);
        }
        
    } catch (err) {
        console.error('❌ Error:', err.message);
        console.error(err.stack);
    }
    
    console.log('\n=== Test Complete ===');
}

main().catch(console.error);
