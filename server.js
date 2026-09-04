```javascript
const express = require('express');
const { chromium } = require('playwright');
const path = require('path');

const app = express();

app.use(express.json());

// Persistent browser profile
const USER_DATA_DIR = path.join(__dirname, '.browser-data');

let browserContext = null;

async function getBrowserContext() {
  if (browserContext) {
    return browserContext;
  }

  browserContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
    // Render has no desktop GUI, so Chromium must be headless.
    headless: true,

    viewport: {
      width: 1280,
      height: 720,
    },

    ignoreDefaultArgs: ['--enable-automation'],

    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  return browserContext;
}

async function closeBrowser() {
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
  }
}

// --------------------------------------------------
// Frontend
// --------------------------------------------------

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// --------------------------------------------------
// Health check for Render
// --------------------------------------------------

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'diskwala-web',
  });
});

// --------------------------------------------------
// Login
// --------------------------------------------------
//
// IMPORTANT:
// Render cannot show a visible browser window.
// Therefore this endpoint can no longer open a visible
// browser for the user.
//
// It simply initializes the persistent browser context.
//
// If authentication is required, you need to provide
// authentication through a separate mechanism.
//

app.post('/api/login', async (_req, res) => {
  try {
    const ctx = await getBrowserContext();

    const page = await ctx.newPage();

    await page.goto('https://www.diskwala.com/login', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    await page.close();

    res.json({
      success: true,
      message:
        'Headless browser initialized. Render cannot display a browser window.',
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// --------------------------------------------------
// Check authentication
// --------------------------------------------------

app.get('/api/check-auth', async (_req, res) => {
  let page = null;

  try {
    const ctx = await getBrowserContext();

    page = await ctx.newPage();

    let loggedIn = false;

    try {
      const authPromise = page.waitForResponse(
        (r) => r.url().includes('/api/v1/auth'),
        {
          timeout: 20000,
        }
      );

      await page.goto('https://www.diskwala.com/dashboard', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      const authResp = await authPromise;

      loggedIn = authResp.status() === 200;
    } catch {
      loggedIn = false;
    }

    res.json({
      loggedIn,
    });
  } catch (err) {
    res.json({
      loggedIn: false,
      error: err.message,
    });
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
  }
});

// --------------------------------------------------
// Switch headless
// --------------------------------------------------
//
// Kept for frontend compatibility.
// Render is always headless.
//

app.post('/api/switch-headless', async (_req, res) => {
  try {
    await closeBrowser();
    await getBrowserContext();

    res.json({
      success: true,
      headless: true,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// --------------------------------------------------
// Get Diskwala download/sign information
// --------------------------------------------------

app.post('/api/get-download', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({
      error: 'URL is required',
    });
  }

  const match = url.match(/\/app\/([a-f0-9]+)/);

  if (!match) {
    return res.status(400).json({
      error:
        'Invalid Diskwala URL. Expected: https://www.diskwala.com/app/<id>',
    });
  }

  const fileId = match[1];

  let page = null;

  try {
    const ctx = await getBrowserContext();

    page = await ctx.newPage();

    // Capture appicrypt headers
    let capturedAppicrypt = '';
    let capturedTs = '';

    page.on('request', (request) => {
      const headers = request.headers();

      if (
        headers['appicrypt'] &&
        request.url().includes('ddudapidd.diskwala.com')
      ) {
        capturedAppicrypt = headers['appicrypt'];
        capturedTs = headers['appicrypt-ts'] || '';
      }
    });

    // Wait for temp_info
    const tempInfoPromise = page.waitForResponse(
      (r) => r.url().includes('/api/v1/file/temp_info'),
      {
        timeout: 30000,
      }
    );

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    const tempInfoResp = await tempInfoPromise;

    const tempInfo = await tempInfoResp
      .json()
      .catch(() => null);

    // Give page/WASM time to finish
    await page.waitForTimeout(1000);

    // Get cookies
    const cookies = await ctx.cookies(
      'https://ddudapidd.diskwala.com'
    );

    const cookieStr = cookies
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');

    // Call sign API
    const signResponse = await page.request.post(
      'https://ddudapidd.diskwala.com/api/v1/file/sign',
      {
        data: {
          id: fileId,
        },

        headers: {
          'Content-Type': 'application/json',

          Appicrypt: capturedAppicrypt,

          'Appicrypt-ts': capturedTs,

          Origin: 'https://www.diskwala.com',

          Referer: 'https://www.diskwala.com/',

          Cookie: cookieStr,
        },
      }
    );

    const signStatus = signResponse.status();

    let signBody;

    try {
      signBody = await signResponse.json();
    } catch {
      signBody = await signResponse.text();
    }

    if (signStatus === 200 && signBody) {
      return res.json({
        success: true,
        fileId,

        fileInfo: tempInfo?.fileInfo || null,

        signData: signBody,
      });
    }

    if (signStatus === 401) {
      return res.json({
        success: false,

        error:
          'Not logged in or authentication expired.',

        fileInfo: tempInfo?.fileInfo || null,
      });
    }

    return res.json({
      success: false,

      error: `Sign API returned ${signStatus}`,

      details: signBody,

      fileInfo: tempInfo?.fileInfo || null,
    });
  } catch (err) {
    console.error('get-download error:', err);

    res.status(500).json({
      success: false,
      error: err.message,
    });
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
  }
});

// --------------------------------------------------
// Proxy download
// --------------------------------------------------

app.get('/api/download', async (req, res) => {
  const downloadUrl = req.query.url;

  const fileName =
    req.query.name || 'download.mp4';

  if (!downloadUrl) {
    return res.status(400).send(
      'Missing download URL'
    );
  }

  try {
    const ctx = await getBrowserContext();

    const response = await ctx.request.get(
      downloadUrl,
      {
        headers: {
          Origin: 'https://www.diskwala.com',

          Referer: 'https://www.diskwala.com/',
        },

        timeout: 120000,
      }
    );

    const contentType =
      response.headers()['content-type'] ||
      'application/octet-stream';

    const contentLength =
      response.headers()['content-length'];

    res.setHeader(
      'Content-Type',
      contentType
    );

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(
        fileName
      )}"`
    );

    if (contentLength) {
      res.setHeader(
        'Content-Length',
        contentLength
      );
    }

    const body = await response.body();

    res.send(body);
  } catch (err) {
    console.error('download error:', err);

    res.status(500).send(
      'Download failed: ' + err.message
    );
  }
});

// --------------------------------------------------
// Shutdown
// --------------------------------------------------

process.on('SIGINT', async () => {
  await closeBrowser();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await closeBrowser();
  process.exit(0);
});

// --------------------------------------------------
// Render server
// --------------------------------------------------

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(
    `Diskwala Downloader running on port ${PORT}`
  );
});
```
