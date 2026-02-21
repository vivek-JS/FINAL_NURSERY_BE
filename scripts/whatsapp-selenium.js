import path from "path";
import { Builder, By, Key } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";

export async function initDriver({ userDataDir = null, headless = false } = {}) {
  const options = new chrome.Options();
  if (userDataDir) {
    const resolvedDir = path.isAbsolute(userDataDir) ? userDataDir : path.resolve(process.cwd(), userDataDir);
    options.addArguments(`--user-data-dir=${resolvedDir}`);
    options.addArguments(`--profile-directory=Default`);
    options.addArguments("--remote-debugging-port=0");
  }
  options.addArguments("--no-sandbox");
  options.addArguments("--disable-dev-shm-usage");
  options.addArguments("--window-size=1280,900");
  options.addArguments("--disable-blink-features=AutomationControlled");
  options.addArguments("--disable-features=ChromeWhatsNewUI");
  if (headless) {
    options.addArguments("--headless=new");
    options.addArguments("--disable-gpu");
  }
  const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();
  return driver;
}

export async function openWhatsAppWeb(driver) {
  await driver.get("https://web.whatsapp.com");
}

export async function waitForLoggedIn(driver, timeoutMs = 90000) {
  const selectors = [
    '[data-testid="chat-list"]',
    '[data-testid="search"]',
    '#pane-side',
    'aside',
    'div[contenteditable="true"][data-tab]',
    'footer div[contenteditable="true"]',
  ];
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const sel of selectors) {
      try {
        const el = await driver.findElement(By.css(sel));
        if (el && (await el.isDisplayed())) return true;
      } catch (e) {}
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Returns true if page shows "contact not found" / "no chats" (number doesn't exist) */
async function isContactNotFound(driver) {
  try {
    const body = await driver.findElement(By.css("body"));
    const text = (await body.getText()) || "";
    const lower = text.toLowerCase();
    if (
      lower.includes("no chats, contacts or messages found") ||
      lower.includes("isn't on whatsapp") ||
      lower.includes("not on whatsapp") ||
      lower.includes("phone number shared via url is invalid")
    ) {
      return true;
    }
  } catch (e) {}
  return false;
}

/** Exclude search box - compose must be in footer/conversation area, not sidebar */
async function isComposeBox(elem) {
  try {
    const title = await elem.getAttribute("title");
    if (title === "Type a message") return true;
    const testId = await elem.getAttribute("data-testid");
    if (testId === "conversation-compose-box-input") return true;
    const inSearch = await elem.findElement(By.xpath("./ancestor::*[contains(@data-testid,'search')]"));
    if (inSearch) return false;
  } catch (e) {
  }
  return true;
}

async function findComposeBox(driver, timeoutMs = 25000) {
  const selectors = [
    '[data-testid="conversation-compose-box-input"]',
    'div[title="Type a message"]',
    'footer div[contenteditable="true"]',
    'div[contenteditable="true"][data-tab="10"]',
    'div[contenteditable="true"][data-tab="1"]',
    'footer div[role="textbox"]',
  ];
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await isContactNotFound(driver)) {
      throw new Error("Number not on WhatsApp");
    }
    for (const sel of selectors) {
      try {
        const elems = await driver.findElements(By.css(sel));
        if (elems && elems.length > 0) {
          for (const e of elems) {
            try {
              if (await e.isDisplayed() && (await isComposeBox(e))) return e;
            } catch (e) {}
          }
        }
      } catch (e) {}
    }
    await sleep(400);
  }
  throw new Error("Compose box not found");
}

async function dismissStartChatDialog(driver) {
  try {
    const dialog = await driver.findElement(By.css('div[role="dialog"]'));
    if (!(await dialog.isDisplayed())) return;
    const btnSelectors = [
      'div[role="dialog"] button[aria-label="Continue"]',
      'div[role="dialog"] button[aria-label="Message"]',
      'div[role="dialog"] span[data-icon="checkmark"]',
      'div[role="dialog"] [data-testid="confirm"]',
      'div[role="dialog"] footer button',
      'div[role="dialog"] button',
    ];
    for (const sel of btnSelectors) {
      try {
        const btn = await driver.findElement(By.css(sel));
        if (await btn.isDisplayed()) {
          await driver.executeScript("arguments[0].click();", btn);
          await sleep(1500);
          return;
        }
      } catch (e) {}
    }
  } catch (e) {}
}

/** Returns true if "number isn't on WhatsApp" dialog was found and dismissed */
async function dismissNumberNotOnWhatsAppDialog(driver) {
  try {
    const dialogs = await driver.findElements(By.css('div[role="dialog"]'));
    for (const dialog of dialogs) {
      try {
        if (!(await dialog.isDisplayed())) continue;
        const text = await dialog.getText();
        if (text && (text.includes("isn't on WhatsApp") || text.includes("not on WhatsApp"))) {
          const okSelectors = [
            'div[role="dialog"] button',
            'div[role="dialog"] footer button',
            'div[role="dialog"] [data-testid="confirm"]',
          ];
          for (const sel of okSelectors) {
            try {
              const btn = await driver.findElement(By.css(sel));
              if (await btn.isDisplayed()) {
                await driver.executeScript("arguments[0].click();", btn);
                await sleep(1000);
                return true;
              }
            } catch (e) {}
          }
        }
      } catch (e) {}
    }
  } catch (e) {}
  return false;
}

export async function sendToNumber(driver, phoneNumber, message) {
  const url = `https://web.whatsapp.com/send?phone=${phoneNumber}`;
  try {
    await driver.get(url);
  } catch (e) {
    throw new Error("Navigation failed: " + (e?.message || e));
  }
  await sleep(3000);

  await dismissStartChatDialog(driver).catch(() => {});
  if (await dismissNumberNotOnWhatsAppDialog(driver)) {
    throw new Error("Number not on WhatsApp");
  }
  if (await isContactNotFound(driver)) {
    throw new Error("Number not on WhatsApp");
  }

  const compose = await findComposeBox(driver, 25000);
  if (!compose) throw new Error("Compose box not available");

  await driver.executeScript("arguments[0].scrollIntoView({block:'center'});", compose).catch(() => {});
  await sleep(500);
  for (let clickAttempt = 0; clickAttempt < 2; clickAttempt++) {
    try {
      await compose.click();
      break;
    } catch (e) {
      if (clickAttempt === 1) await driver.executeScript("arguments[0].click();", compose);
      else await sleep(300);
    }
  }
  await sleep(400);
  await driver.executeScript("arguments[0].focus();", compose).catch(() => {});
  await sleep(200);

  let typed = false;
  try {
    await compose.sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE);
    await compose.sendKeys(message);
    typed = true;
  } catch (e) {
    try {
      await compose.clear();
      await compose.sendKeys(message);
      typed = true;
    } catch (e2) {}
  }
  if (!typed) {
    for (const ch of message) {
      try {
        await compose.sendKeys(ch);
        typed = true;
      } catch (e) {}
      await sleep(25);
    }
  }
  if (!typed) throw new Error("Failed to type message");

  await sleep(600);
  let sent = false;
  const sendSelectors = [
    'span[data-icon="send"]',
    'button[aria-label="Send"]',
    '[data-testid="send"]',
    '.compose-btn-send',
    'button[data-tab="11"]',
    'footer button[aria-label]',
  ];
  for (const sel of sendSelectors) {
    try {
      const btns = await driver.findElements(By.css(sel));
      for (const btn of btns) {
        if (await btn.isDisplayed()) {
          await driver.executeScript("arguments[0].click();", btn);
          sent = true;
          break;
        }
      }
      if (sent) break;
    } catch (e) {}
  }
  if (!sent) {
    await compose.sendKeys(Key.RETURN);
  }
  await sleep(3000);
  return { ok: true };
}

// Attach files (array of absolute file paths) and optional caption message, then send
export async function sendMediaAndMessage(driver, phoneNumber, message, filePaths = []) {
  const url = `https://web.whatsapp.com/send?phone=${phoneNumber}`;
  try {
    await driver.get(url);
  } catch (e) {
    throw new Error("Navigation failed: " + (e?.message || e));
  }
  await sleep(3000);
  await dismissStartChatDialog(driver).catch(() => {});
  if (await dismissNumberNotOnWhatsAppDialog(driver)) {
    throw new Error("Number not on WhatsApp");
  }
  if (await isContactNotFound(driver)) {
    throw new Error("Number not on WhatsApp");
  }
  await findComposeBox(driver, 25000);

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

