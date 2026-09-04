```javascript
const express = require('express');
const { chromium } = require('playwright');
const path = require('path');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --------------------------------------------------
// Configuration
// --------------------------------------------------

const USER_DATA_DIR = path.join(__dirname, '.browser-data');

let browserContext = null;

// --------------------------------------------------
// Browser
// --------------------------------------------------

async function getBrowserContext() {
  if (browserContext) {
    return browserContext;
  }

  console.log('Starting Playwright Chromium...');

  browserContext = await chromium.launchPersistentContext(
    USER_DATA_DIR,
    {
      // Render does not provide a desktop GUI.
      headless: true,

      viewport: {
        width: 1280,
        height: 720,
      },

      ignoreDefaultArgs: [
        '--enable-automation',
      ],

      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-sync',
        '--disable-blink-features=AutomationControlled',
      ],
    }
  );

  console.log('Chromium started successfully.');

  return browserContext;
}

// --------------------------------------------------
// Close browser
// --------------------------------------------------

async function closeBrowser() {
  if (browserContext) {
    try {
      await browserContext.close();
    } catch (err) {
      console.error(
        'Browser close error:',
        err.message
      );
    }

    browserContext = null;
  }
}

// --------------------------------------------------
// Frontend
// --------------------------------------------------

app.get('/', (_req, res) => {
  res.sendFile(
    path.join(__dirname, 'index.html')
  );
});

// --------------------------------------------------
// Health check
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
// Render is a headless server, so it cannot display
// a browser window for interactive Google login.
//
// This endpoint initializes the browser and opens
// the Diskwala login page in headless mode.
//

app.post('/api/login', async (_req, res) => {
  let page = null;

  try {
    const ctx = await getBrowserContext();

    page = await ctx.newPage();

    await page.goto(
      'https://www.diskwala.com/login',
      {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      }
    );

    res.json({
      success: true,
      message:
        'Headless browser initialized. Render cannot display an interactive browser window.',
    });
  } catch (err) {
    console.error(
      'Login error:',
      err.message
    );

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
// Check authentication
// --------------------------------------------------

app.get('/api/check-auth', async (_req, res) => {
  let page = null;

  try {
    const ctx = await getBrowserContext();

    page = await ctx.newPage();

    let loggedIn = false;

    try {
      const authPromise =
        page.waitForResponse(
          (response) =>
            response
              .url()
              .includes('/api/v1/auth'),
          {
            timeout: 20000,
          }
        );

      await page.goto(
        'https://www.diskwala.com/dashboard',
        {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        }
      );

      const authResponse =
        await authPromise;

      loggedIn =
        authResponse.status() === 200;
    } catch (err) {
      console.log(
        'Auth check did not receive auth response:',
        err.message
      );

      loggedIn = false;
    }

    res.json({
      loggedIn,
    });
  } catch (err) {
    console.error(
      'Check-auth error:',
      err.message
    );

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
// Render is always headless.
//

app.post(
  '/api/switch-headless',
  async (_req, res) => {
    try {
      await closeBrowser();

      await getBrowserContext();

      res.json({
        success: true,
        headless: true,
      });
    } catch (err) {
      console.error(
        'Switch-headless error:',
        err.message
      );

      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  }
);

// --------------------------------------------------
// Get download/sign information
// --------------------------------------------------

app.post(
  '/api/get-download',
  async (req, res) => {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'URL is required',
      });
    }

    const match =
      url.match(/\/app\/([a-f0-9]+)/);

    if (!match) {
      return res.status(400).json({
        success: false,
        error:
          'Invalid Diskwala URL. Expected: https://www.diskwala.com/app/<id>',
      });
    }

    const fileId = match[1];

    let page = null;

    try {
      const ctx =
        await getBrowserContext();

      page = await ctx.newPage();

      // ------------------------------------------
      // Capture request headers
      // ------------------------------------------

      let capturedAppicrypt = '';
      let capturedTs = '';

      page.on(
        'request',
        (request) => {
          const headers =
            request.headers();

          if (
            headers['appicrypt'] &&
            request
              .url()
              .includes(
                'ddudapidd.diskwala.com'
              )
          ) {
            capturedAppicrypt =
              headers['appicrypt'];

            capturedTs =
              headers['appicrypt-ts'] ||
              '';
          }
        }
      );

      // ------------------------------------------
      // Wait for temp_info
      // ------------------------------------------

      const tempInfoPromise =
        page.waitForResponse(
          (response) =>
            response
              .url()
              .includes(
                '/api/v1/file/temp_info'
              ),
          {
            timeout: 30000,
          }
        );

      await page.goto(url, {
        waitUntil:
          'domcontentloaded',
        timeout: 30000,
      });

      const tempInfoResponse =
        await tempInfoPromise;

      const tempInfo =
        await tempInfoResponse
          .json()
          .catch(() => null);

      // ------------------------------------------
      // Allow page scripts/WASM to finish
      // ------------------------------------------

      await page.waitForTimeout(1000);

      // ------------------------------------------
      // Cookies
      // ------------------------------------------

      const cookies =
        await ctx.cookies(
          'https://ddudapidd.diskwala.com'
        );

      const cookieStr =
        cookies
          .map(
            (c) =>
              `${c.name}=${c.value}`
          )
          .join('; ');

      // ------------------------------------------
      // Sign request
      // ------------------------------------------

      const signResponse =
        await page.request.post(
          'https://ddudapidd.diskwala.com/api/v1/file/sign',
          {
            data: {
              id: fileId,
            },

            headers: {
              'Content-Type':
                'application/json',

              Appicrypt:
                capturedAppicrypt,

              'Appicrypt-ts':
                capturedTs,

              Origin:
                'https://www.diskwala.com',

              Referer:
                'https://www.diskwala.com/',

              Cookie:
                cookieStr,
            },

            timeout: 30000,
          }
        );

      const signStatus =
        signResponse.status();

      // ------------------------------------------
      // Parse response
      // ------------------------------------------

      let signBody;

      try {
        signBody =
          await signResponse.json();
      } catch (err) {
        signBody =
          await signResponse.text();
      }

      // ------------------------------------------
      // Success
      // ------------------------------------------

      if (
        signStatus === 200 &&
        signBody
      ) {
        return res.json({
          success: true,

          fileId,

          fileInfo:
            tempInfo?.fileInfo ||
            null,

          signData: signBody,
        });
      }

      // ------------------------------------------
      // Authentication failure
      // ------------------------------------------

      if (signStatus === 401) {
        return res.json({
          success: false,

          error:
            'Not logged in or authentication expired.',

          fileInfo:
            tempInfo?.fileInfo ||
            null,
        });
      }

      // ------------------------------------------
      // Other API error
      // ------------------------------------------

      return res.json({
        success: false,

        error:
          `Sign API returned ${signStatus}`,

        details: signBody,

        fileInfo:
          tempInfo?.fileInfo ||
          null,
      });
    } catch (err) {
      console.error(
        'get-download error:',
        err
      );

      return res.status(500).json({
        success: false,
        error: err.message,
      });
    } finally {
      if (page) {
        await page.close().catch(
          () => {}
        );
      }
    }
  }
);

// --------------------------------------------------
// Proxy download
// --------------------------------------------------

app.get(
  '/api/download',
  async (req, res) => {
    const downloadUrl =
      req.query.url;

    const fileName =
      req.query.name ||
      'download.mp4';

    if (!downloadUrl) {
      return res
        .status(400)
        .send(
          'Missing download URL'
        );
    }

    try {
      const ctx =
        await getBrowserContext();

      const response =
        await ctx.request.get(
          downloadUrl,
          {
            headers: {
              Origin:
                'https://www.diskwala.com',

              Referer:
                'https://www.diskwala.com/',
            },

            timeout: 120000,
          }
        );

      const contentType =
        response
          .headers()
          ['content-type'] ||
        'application/octet-stream';

      const contentLength =
        response
          .headers()
          ['content-length'];

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

      const body =
        await response.body();

      res.send(body);
    } catch (err) {
      console.error(
        'Download error:',
        err
      );

      if (!res.headersSent) {
        res
          .status(500)
          .send(
            'Download failed: ' +
              err.message
          );
      }
    }
  }
);

// --------------------------------------------------
// Shutdown
// --------------------------------------------------

async function shutdown() {
  console.log(
    'Shutting down...'
  );

  await closeBrowser();

  process.exit(0);
}

process.on(
  'SIGINT',
  shutdown
);

process.on(
  'SIGTERM',
  shutdown
);

// --------------------------------------------------
// Start server
// --------------------------------------------------

const PORT =
  process.env.PORT || 3000;

app.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      `Diskwala Downloader running on port ${PORT}`
    );
  }
);
```
