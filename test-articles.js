const { chromium } = require('playwright');
const path = require('path');

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    // Test 1: Index page
    console.log('\n=== Test 1: Index Page ===');
    const indexPath = 'file://' + path.resolve(__dirname, 'index.html');
    await page.goto(indexPath, { waitUntil: 'networkidle' });
    console.log('Index page loaded');

    const title = await page.title();
    console.log('Page title:', title);

    // Check article cards
    const articleCards = await page.$$('.article-card');
    console.log('Article cards found:', articleCards.length);

    // Check data-slug attributes
    const slugs = await page.$$eval('.article-card', cards =>
        cards.map(c => c.getAttribute('data-slug'))
    );
    console.log('Article slugs:', slugs);

    // Test 2: Article detail page
    console.log('\n=== Test 2: Article Detail Page ===');
    const articlePath = 'file://' + path.resolve(__dirname, 'article.html');
    await page.goto(articlePath, { waitUntil: 'networkidle' });
    console.log('Article page loaded');

    // Article page should show loading state initially
    const loadingSpinner = await page.$('.loading-spinner');
    console.log('Loading spinner visible:', !!loadingSpinner);

    // Check for article slug parameter handling
    await page.goto(articlePath + '?slug=vite-vue3-guide', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    const articleContainer = await page.$('#articleContainer');
    const containerContent = await articleContainer.innerHTML();
    console.log('Article container has content:', containerContent.length > 100);

    // Check if article content loaded (or error message if markdown not accessible)
    const hasError = containerContent.includes('error') || containerContent.includes('加载');
    console.log('Article content or loading state:', !hasError || containerContent.length > 200);

    // Test 3: Check articles directory structure
    console.log('\n=== Test 3: Articles Directory ===');
    const fs = require('fs');
    const articlesDir = path.resolve(__dirname, 'articles');
    const files = fs.readdirSync(articlesDir);
    console.log('Files in articles directory:', files);

    // Check for markdown files
    const mdFiles = files.filter(f => f.endsWith('.md'));
    console.log('Markdown files:', mdFiles.length);

    // Check for articles.json
    const hasJson = files.includes('articles.json');
    console.log('articles.json exists:', hasJson);

    console.log('\n✅ All tests completed!');

    await browser.close();
})();
