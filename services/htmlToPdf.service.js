/**
 * Render HTML string to PDF buffer via headless Chrome (Puppeteer).
 * Set PUPPETEER_EXECUTABLE_PATH for custom Chrome, or SKIP_PUPPETEER_PDF=1 to use PDFKit fallback.
 */

let browserPromise = null;

async function getBrowser() {
  if (process.env.SKIP_PUPPETEER_PDF === "1") return null;
  if (!browserPromise) {
    browserPromise = (async () => {
      const puppeteer = await import("puppeteer");
      const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
      return puppeteer.default.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
        ...(executablePath ? { executablePath } : {}),
      });
    })().catch((err) => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

/**
 * @param {string} html — full HTML document
 * @param {{ format?: string, width?: string, height?: string, margin?: object }} [opts]
 * @returns {Promise<Buffer>}
 */
export async function htmlToPdfBuffer(html, opts = {}) {
  const browser = await getBrowser();
  if (!browser) {
    throw new Error("Puppeteer unavailable (SKIP_PUPPETEER_PDF=1)");
  }
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 60000 });
    const pdfOpts = {
      printBackground: true,
      preferCSSPageSize: true,
      margin: opts.margin ?? { top: "0", right: "0", bottom: "0", left: "0" },
    };
    if (opts.width && opts.height) {
      pdfOpts.width = opts.width;
      pdfOpts.height = opts.height;
    } else {
      pdfOpts.format = opts.format || "A4";
    }
    const buf = await page.pdf(pdfOpts);
    return Buffer.from(buf);
  } finally {
    await page.close();
  }
}

export async function closePdfBrowser() {
  if (browserPromise) {
    try {
      const b = await browserPromise;
      await b.close();
    } catch {
      /* ignore */
    }
    browserPromise = null;
  }
}
