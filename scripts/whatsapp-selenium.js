import { Builder, By, Key } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";

export async function initDriver({ userDataDir = null, headless = false } = {}) {
  const options = new chrome.Options();
  if (userDataDir) {
    options.addArguments(`--user-data-dir=${userDataDir}`);
    options.addArguments("--remote-debugging-port=9222");
  }
  if (headless) {
    options.addArguments("--headless=new");
    options.addArguments("--disable-gpu");
  }
  options.addArguments("--no-sandbox");
  options.addArguments("--disable-dev-shm-usage");
  const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();
  return driver;
}

async function findComposeBox(driver, timeoutMs = 15000) {
  const selectors = [
    'div[contenteditable="true"][data-tab]',
    'div[contenteditable="true"][spellcheck="true"]',
    'div[title="Type a message"]',
    'footer div[contenteditable="true"]',
  ];
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const sel of selectors) {
      const elems = await driver.findElements(By.css(sel));
      if (elems && elems.length > 0) {
        for (const e of elems) {
          try {
            if (await e.isDisplayed()) return e;
          } catch (e) {}
        }
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("Compose box not found");
}

export async function sendToNumber(driver, phoneNumber, message) {
  const url = `https://web.whatsapp.com/send?phone=${phoneNumber}`;
  await driver.get(url);
  const compose = await findComposeBox(driver, 12000);
  if (!compose) throw new Error("Compose box not available");
  await compose.click();
  // If no media, just send simple text
  await compose.sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE);
  await compose.sendKeys(message);
  await compose.sendKeys(Key.RETURN);
  return { ok: true };
}

// Attach files (array of absolute file paths) and optional caption message, then send
export async function sendMediaAndMessage(driver, phoneNumber, message, filePaths = []) {
  const url = `https://web.whatsapp.com/send?phone=${phoneNumber}`;
  await driver.get(url);
  // Wait for page / chat to be ready
  await findComposeBox(driver, 15000);

  if (!filePaths || filePaths.length === 0) {
    // Fallback to text send
    return await sendToNumber(driver, phoneNumber, message);
  }

  // Find a file input on the page. WhatsApp Web uses an <input type="file"> inside the clip menu or attachment dialog.
  const inputs = await driver.findElements(By.css('input[type="file"]'));
  if (!inputs || inputs.length === 0) {
    throw new Error("File input element not found on WhatsApp Web");
  }

  // Choose the first input and send file paths joined by newline (supports multiple)
  const fileInput = inputs[0];
  const pathsStr = Array.isArray(filePaths) ? filePaths.join("\n") : String(filePaths);
  await fileInput.sendKeys(pathsStr);

  // Wait for the attachment preview/dialog to appear
  const start = Date.now();
  let sendButton = null;
  while (Date.now() - start < 30000) {
    try {
      const btns = await driver.findElements(By.css('span[data-icon="send"]'));
      if (btns && btns.length > 0) {
        // pick the visible one
        for (const b of btns) {
          try {
            if (await b.isDisplayed()) {
              sendButton = b;
              break;
            }
          } catch (e) {}
        }
      }
      if (sendButton) break;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 500));
  }

  // Optionally set caption: find the caption box in the attachment dialog
  if (message) {
    try {
      // Attachment caption area is contenteditable; try common selectors
      const captionSelectors = [
        'div[contenteditable="true"][data-tab]',
        'div[contenteditable="true"][spellcheck="true"]',
        'div[role="textbox"][contenteditable="true"]',
      ];
      for (const sel of captionSelectors) {
        const elems = await driver.findElements(By.css(sel));
        if (elems && elems.length > 0) {
          for (const el of elems) {
            try {
              if (await el.isDisplayed()) {
                await el.click();
                await el.sendKeys(message);
                // don't break here; continue to ensure caption is set
                break;
              }
            } catch (e) {}
          }
        }
      }
    } catch (e) {
      // ignore caption failure
    }
  }

  if (!sendButton) {
    throw new Error("Could not find send button after attaching media");
  }

  await sendButton.click();
  return { ok: true };
}

export async function closeDriver(driver) {
  try {
    await driver.quit();
  } catch (e) {}
}

