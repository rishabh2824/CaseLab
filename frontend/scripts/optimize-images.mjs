// One-off/re-runnable image optimization: converts src/assets raster images to
// WebP, resized to a sane cap for their actual rendered size (not left at
// native resolution). Re-run after replacing any source art.
import sharp from 'sharp'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ASSETS = new URL('../src/assets/', import.meta.url)
const OUT_DIR = new URL('../scripts/output/', import.meta.url)
mkdirSync(OUT_DIR, { recursive: true })

// { file, maxWidth (resize cap, preserves aspect), webpQuality, alsoJpeg (fallback for the CSS image-set background) }
const jobs = [
    { file: 'Bg.jpg', maxWidth: 2560, webpQuality: 82, alsoJpeg: true, jpegQuality: 80 },
    { file: 'Modified-Chevron-Layered-Grey.png', maxWidth: 1000, webpQuality: 82 },
    { file: 'GraphicElements-Red-Digital-HalfCircle.png', maxWidth: 800, webpQuality: 82 },
    { file: 'WSBLogo.png', maxWidth: 500, webpQuality: 90 },
    { file: 'WSBLogo-NoTagline.png', maxWidth: 500, webpQuality: 90 },
]

for (const job of jobs) {
    const input = fileURLToPath(new URL(job.file, ASSETS))
    const base = job.file.replace(/\.(jpg|jpeg|png)$/i, '')
    const pipeline = sharp(input).resize({ width: job.maxWidth, withoutEnlargement: true })

    const webpOut = fileURLToPath(new URL(`${base}.webp`, OUT_DIR))
    await pipeline.clone().webp({ quality: job.webpQuality }).toFile(webpOut)

    if (job.alsoJpeg) {
        const jpegOut = fileURLToPath(new URL(`${base}.jpg`, OUT_DIR))
        await pipeline.clone().jpeg({ quality: job.jpegQuality, mozjpeg: true }).toFile(jpegOut)
    }

    console.log(`done: ${job.file}`)
}
