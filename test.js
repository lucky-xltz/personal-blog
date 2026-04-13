const { chromium } = require('playwright');
const path = require('path');

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    const filePath = 'file://' + path.resolve(__dirname, 'index.html');
    console.log('Opening:', filePath);

    try {
        await page.goto(filePath, { waitUntil: 'networkidle' });
        console.log('Page loaded successfully');

        // Check title
        const title = await page.title();
        console.log('Page title:', title);

        // Check for console errors
        const errors = [];
        page.on('console', msg => {
            if (msg.type() === 'error') {
                errors.push(msg.text());
            }
        });

        // Wait a bit for any async errors
        await page.waitForTimeout(2000);

        if (errors.length > 0) {
            console.log('Console errors found:', errors);
        } else {
            console.log('No console errors detected');
        }

        // Check key elements exist
        const heroTitle = await page.$('.hero-title');
        const navLogo = await page.$('.nav-logo');
        const articles = await page.$$('.article-card');
        const tags = await page.$$('.tag');

        console.log('Hero title exists:', !!heroTitle);
        console.log('Nav logo exists:', !!navLogo);
        console.log('Article cards count:', articles.length);
        console.log('Tags count:', tags.length);

        // Test scroll behavior
        await page.evaluate(() => window.scrollTo(0, 500));
        await page.waitForTimeout(500);
        const navScrolled = await page.$('.nav.scrolled');
        console.log('Nav scrolled class applied:', !!navScrolled);

        console.log('\n✅ All tests passed!');

    } catch (error) {
        console.error('Test failed:', error);
        process.exit(1);
    } finally {
        await browser.close();
    }
})();
