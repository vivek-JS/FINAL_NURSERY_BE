#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { Builder, By, Key, until } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";
import * as xlsx from "xlsx";
import { cleanAndValidateMobileNumber } from "../controllers/excel.serveces.controller.js";

// Simple arg parsing
const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const k = a.replace(/^--/, "");
    const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    args[k] = v;
  }
}

const EXCEL_PATH = args.excel || args.file;
const SHEET_NAME = args.sheet || null;
const PHONE_COLUMN = args.column || args.col || "Mobile";
const MESSAGE = args.message || args.msg || args.m || "";
const PER_ROW_MESSAGE_COLUMN = args["per-row-message-column"] || args.messageColumn || null;
const COUNTRY_CODE = String(args["country-code"] || args.code || "91");
const DELAY_SEC = Number(args.delay || args.d || 8);
const CHROME_USER_DATA = args["chrome-user-data"] || args.profile || null;
const HEADLESS = args.headless === "true" || args.headless === true || false;
const DRY_RUN = args["dry-run"] === "true" || args["dry-run"] === true || false;
const LOG_PATH = args.log || path.join(process.cwd(), "whatsapp-send-log.csv");
const MAX_SEND = args["max"] ? Number(args["max"]) : Infinity;

if (!EXCEL_PATH) {
  console.error("Missing --excel path. Example: --excel contacts.xlsx");
  process.exit(2);
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function toCsvLine(arr) {
  return arr
    .map((v) => {
      if (v === null || v === undefined) return "";
      const s = String(v).replace(/"/g, '""');
      return `"${s}"`;
    })
    .join(",");
}

async function readExcel(filePath) {
  const workbook = xlsx.readFile(filePath);
  const sheetName = SHEET_NAME || workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found`);
  const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });
  return { rows, sheetName };
}

async function launchDriver() {
  const options = new chrome.Options();
  if (CHROME_USER_DATA) {
    options.addArguments(`--user-data-dir=${path.resolve(CHROME_USER_DATA)}`);
  }
  if (HEADLESS) {
    options.addArguments("--headless=new");
    options.addArguments("--disable-gpu");
  }
  options.addArguments("--no-sandbox");
  options.addArguments("--disable-dev-shm-usage");

  const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();
  return driver;
}

async function waitForLoggedIn(driver, timeoutMs = 120000) {
  // Wait until chat list/sidebar is present
  const sidebarSelectors = [
    'div[role="grid"]', // sometimes chat list
    'div[aria-label="Chat list"]',
    'div[role="region"]',
  ];
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      for (const sel of sidebarSelectors) {
        const elems = await driver.findElements(By.css(sel));
        if (elems && elems.length > 0) return true;
      }
    } catch (e) {
      // ignore
    }
    await sleep(1000);
  }
  return false;
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
        // return first visible element
        for (const e of elems) {
          try {
            if (await e.isDisplayed()) return e;
          } catch (e) {}
        }
      }
    }
    await sleep(500);
  }
  throw new Error("Compose box not found");
}

async function sendMessageTo(driver, phoneNumber, message) {
  // Build whatsapp send URL
  const url = `https://web.whatsapp.com/send?phone=${phoneNumber}`;
  await driver.get(url);
  // Wait for compose box
  const compose = await driver.wait(async () => {
    try {
      return await findComposeBox(driver, 8000);
    } catch {
      return null;
    }
  }, 20000);
  if (!compose) throw new Error("Compose box not available");

  // click into box and send message text
  await compose.click();
  // clear any prefilled text (some pages prefill with text query param)
  await compose.sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE);
  await compose.sendKeys(message);
  await compose.sendKeys(Key.RETURN);
  return true;
}

async function main() {
  const { rows, sheetName } = await readExcel(EXCEL_PATH);
  console.log(`Read ${rows.length} rows from sheet "${sheetName}"`);

  // find phone column header case-insensitively
  const headerNames = Object.keys(rows[0] || {});
  const phoneHeader =
    headerNames.find((h) => String(h).toLowerCase() === PHONE_COLUMN.toLowerCase()) ||
    headerNames.find((h) => ["mobile", "mobileNumber", "phonenumber", "phone", "whatsapp"].includes(String(h).toLowerCase())) ||
    headerNames[0];

  console.log(`Using phone column: ${phoneHeader}`);

  // Prepare log file header
  if (!fs.existsSync(LOG_PATH)) {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    const header = toCsvLine([
      "timestamp",
      "rowIndex",
      "originalValue",
      "normalizedNumber",
      "message",
      "status",
      "error",
    ]);
    fs.writeFileSync(LOG_PATH, header + "\n");
  }

  // dry-run: just list numbers
  const normalizedList = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const original = row[phoneHeader];
    const cleaned = cleanAndValidateMobileNumber(String(original || ""));
    if (cleaned.primaryNumber) {
      // normalized primaryNumber is integer in controller - ensure string and country code
      const numStr = String(cleaned.primaryNumber).padStart(10, "0");
      const fullNumber = `${COUNTRY_CODE}${numStr}`;
      const perRowMessage = PER_ROW_MESSAGE_COLUMN ? (row[PER_ROW_MESSAGE_COLUMN] || MESSAGE) : MESSAGE;
      normalizedList.push({ rowIndex: i + 2, original, fullNumber, message: perRowMessage });
    } else {
      // log invalid
      const line = toCsvLine([new Date().toISOString(), i + 2, original, "", PER_ROW_MESSAGE_COLUMN ? row[PER_ROW_MESSAGE_COLUMN] || MESSAGE : MESSAGE, "invalid", "invalid phone"]);
      fs.appendFileSync(LOG_PATH, line + "\n");
    }
  }

  if (DRY_RUN) {
    console.log("Dry run - numbers to send:");
    normalizedList.forEach((r) => console.log(r));
    process.exit(0);
  }

  if (normalizedList.length === 0) {
    console.error("No valid numbers found to send.");
    process.exit(3);
  }

  const driver = await launchDriver();
  try {
    await driver.get("https://web.whatsapp.com");
    const loggedIn = await waitForLoggedIn(driver, 120000);
    if (!loggedIn) {
      console.error("WhatsApp Web not ready. Please scan QR in opened browser profile and re-run (or use --chrome-user-data to persist profile).");
      await driver.quit();
      process.exit(4);
    }

    let sentCount = 0;
    for (const item of normalizedList) {
      if (sentCount >= MAX_SEND) break;
      try {
        console.log(`Sending to ${item.fullNumber} (row ${item.rowIndex}) ...`);
        await sendMessageTo(driver, item.fullNumber, item.message || MESSAGE);
        const line = toCsvLine([new Date().toISOString(), item.rowIndex, item.original, item.fullNumber, item.message, "sent", ""]);
        fs.appendFileSync(LOG_PATH, line + "\n");
        sentCount++;
      } catch (err) {
        console.error(`Failed for ${item.fullNumber}:`, err.message || err);
        const line = toCsvLine([new Date().toISOString(), item.rowIndex, item.original, item.fullNumber, item.message, "error", err.message || String(err)]);
        fs.appendFileSync(LOG_PATH, line + "\n");
      }
      // delay between messages
      const jitter = Math.max(1000, (DELAY_SEC + Math.floor(Math.random() * 5)) * 1000);
      await sleep(jitter);
    }

    console.log(`Done. Sent: ${sentCount}. Log: ${LOG_PATH}`);
  } finally {
    await driver.quit();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * WhatsApp Selenium Bot – send messages to phone numbers from an Excel file.
 * Uses WhatsApp Web in a browser (no WATI API). For legitimate, consented use only.
 *
 * Usage:
 *   Excel:  node scripts/whatsapp-selenium-bot.js --excel path/to/numbers.xlsx --message "Hello" [options]
 *   Single: node scripts/whatsapp-selenium-bot.js --number 9405679107 --message "Hello" [options]
 *
 * Options:
 *   --excel <path>           Path to Excel file (use with --message for bulk send)
 *   --number <phone>         Single phone number (10 digits or with country code); alternative to --excel
 *   --message <text>         Message to send to all (required unless --message-file)
 *   --message-file <path>    Path to text file containing message (alternative to --message)
 *   --column <name>          Excel column name for phone numbers (default: Mobile, or first of Mobile|Phone|mobileNumber|WhatsApp)
 *   --message-column <name>  Excel column for per-row message (optional; if missing, use --message)
 *   --sheet <name>           Sheet name (default: first sheet)
 *   --country-code <code>    Country code without + (default: 91)
 *   --delay <seconds>        Delay between sends in seconds (default: 10)
 *   --max <n>                Max number of messages to send this run (default: no limit)
 *   --chrome-user-data <dir> Chrome user data dir to reuse session (avoid QR each time)
 *   --keep-open <seconds>    Keep browser open after sending (default: 5) so message can deliver
 *   --headless               Run Chrome headless (not recommended for first login)
 *   --dry-run                Only print numbers and message, do not open browser
 */

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import XLSX from "xlsx";
import { Builder, By, until } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_PHONE_COLUMNS = ["Mobile", "Phone", "mobileNumber", "WhatsApp", "Contact"];
const LOGIN_TIMEOUT_MS = 180000; // 3 minutes to scan QR
const LOGIN_POLL_MS = 3000;      // check every 3 seconds
const LOGIN_MESSAGE_INTERVAL_MS = 15000; // remind user every 15 seconds
const CHAT_READY_TIMEOUT_MS = 25000;
const SEND_KEY_DELAY_MS = 50;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    excel: null,
    number: null,
    message: null,
    messageFile: null,
    column: null,
    messageColumn: null,
    sheet: null,
    countryCode: "91",
    delay: 10,
    max: null,
    chromeUserData: null,
    keepOpen: null,
    headless: false,
    dryRun: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--excel" && args[i + 1]) {
      opts.excel = args[++i];
    } else if (args[i] === "--number" && args[i + 1]) {
      opts.number = args[++i];
    } else if (args[i] === "--message" && args[i + 1]) {
      opts.message = args[++i];
    } else if (args[i] === "--message-file" && args[i + 1]) {
      opts.messageFile = args[++i];
    } else if (args[i] === "--column" && args[i + 1]) {
      opts.column = args[++i];
    } else if (args[i] === "--message-column" && args[i + 1]) {
      opts.messageColumn = args[++i];
    } else if (args[i] === "--sheet" && args[i + 1]) {
      opts.sheet = args[++i];
    } else if (args[i] === "--country-code" && args[i + 1]) {
      opts.countryCode = String(args[++i]).replace(/\D/g, "") || "91";
    } else if (args[i] === "--delay" && args[i + 1]) {
      opts.delay = Math.max(1, parseInt(args[++i], 10) || 10);
    } else if (args[i] === "--max" && args[i + 1]) {
      opts.max = Math.max(1, parseInt(args[++i], 10));
    } else if (args[i] === "--chrome-user-data" && args[i + 1]) {
      opts.chromeUserData = args[++i];
    } else if (args[i] === "--keep-open" && args[i + 1]) {
      opts.keepOpen = args[++i];
    } else if (args[i] === "--headless") {
      opts.headless = true;
    } else if (args[i] === "--dry-run") {
      opts.dryRun = true;
    }
  }
  return opts;
}

function resolvePath(inputPath) {
  if (path.isAbsolute(inputPath)) return inputPath;
  return path.resolve(process.cwd(), inputPath);
}

function normalizePhone(raw, countryCode = "91") {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 0) return null;
  let ten = digits;
  if (digits.length === 12 && digits.startsWith("91")) {
    ten = digits.slice(2);
  } else if (digits.length === 11 && digits.startsWith("0")) {
    ten = digits.slice(1);
  }
  if (ten.length !== 10 || !/^\d{10}$/.test(ten)) return null;
  return ten;
}

function readNumbersFromExcel(excelPath, sheetName, phoneColumn, messageColumn) {
  const resolved = resolvePath(excelPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Excel file not found: ${resolved}`);
  }
  const buffer = fs.readFileSync(resolved);
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false });
  const sheet = sheetName
    ? workbook.Sheets[sheetName]
    : workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) {
    throw new Error(
      sheetName ? `Sheet "${sheetName}" not found` : "Workbook has no sheets"
    );
  }
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: true });
  if (rows.length === 0) {
    return { entries: [], skipped: 0, invalid: [] };
  }

  const headers = Object.keys(rows[0]);
  let actualPhoneCol = null;
  if (phoneColumn) {
    const exact = headers.find((h) => h.trim() === phoneColumn.trim());
    if (!exact) {
      throw new Error(
        `Column "${phoneColumn}" not found. Available: ${headers.join(", ")}`
      );
    }
    actualPhoneCol = exact;
  } else {
    actualPhoneCol =
      DEFAULT_PHONE_COLUMNS.find((c) => headers.some((h) => h.trim() === c)) ||
      headers.find((h) => /mobile|phone|whatsapp|contact/i.test(String(h)));
    if (!actualPhoneCol) {
      throw new Error(
        `No phone column found. Use --column. Available: ${headers.join(", ")}`
      );
    }
  }
  const msgCol = messageColumn && headers.includes(messageColumn) ? messageColumn : null;

  const entries = [];
  const invalid = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const raw = row[actualPhoneCol];
    const ten = normalizePhone(raw);
    if (!ten) {
      invalid.push({ row: i + 2, raw: raw != null ? String(raw).slice(0, 30) : "" });
      continue;
    }
    const message = msgCol && row[msgCol] != null ? String(row[msgCol]).trim() : null;
    entries.push({ phone: ten, message });
  }
  return {
    entries,
    skipped: invalid.length,
    invalid,
  };
}

function loadMessage(opts) {
  if (opts.message) return opts.message;
  if (opts.messageFile) {
    const p = resolvePath(opts.messageFile);
    if (!fs.existsSync(p)) throw new Error(`Message file not found: ${p}`);
    return fs.readFileSync(p, "utf8").trim();
  }
  throw new Error("Provide --message or --message-file");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForLogin(driver) {
  // Elements that appear only when logged in (WhatsApp Web layout can vary by version)
  const loggedInSelectors = [
    '[data-testid="chat-list"]',
    '[data-testid="search"]',
    '#pane-side',
    'header [data-testid="search"]',
    'div[contenteditable="true"][data-tab="3"]',
    'div[contenteditable="true"][data-tab="10"]',
    'div[role="textbox"]',
    'div[data-tab="1"]',
    'aside',
    'footer div[contenteditable="true"]',
  ];
  const start = Date.now();
  let lastMessage = 0;
  while (Date.now() - start < LOGIN_TIMEOUT_MS) {
    for (const sel of loggedInSelectors) {
      try {
        const el = await driver.findElement(By.css(sel));
        if (el && (await el.isDisplayed())) return true;
      } catch {
        continue;
      }
    }
    if (Date.now() - lastMessage >= LOGIN_MESSAGE_INTERVAL_MS) {
      console.log("  Still waiting... Scan the QR code in the Chrome window.");
      lastMessage = Date.now();
    }
    await sleep(LOGIN_POLL_MS);
  }
  return false;
}

async function sendToNumber(driver, countryCode, phone, message, report) {
  const fullNumber = countryCode + phone;
  const url = `https://web.whatsapp.com/send?phone=${fullNumber}`;
  await driver.get(url);
  await sleep(2500);

  // Dismiss "Start chat" / confirmation dialog if present (it blocks the message box)
  try {
    const dialog = await driver.findElement(By.css('div[role="dialog"]'));
    if (await dialog.isDisplayed()) {
      const dialogButtonSelectors = [
        'div[role="dialog"] button[aria-label="Continue"]',
        'div[role="dialog"] button[aria-label="Message"]',
        'div[role="dialog"] span[data-icon="checkmark"]',
        'div[role="dialog"] [data-testid="confirm"]',
        'div[role="dialog"] button',
        'div[role="dialog"] footer button',
      ];
      for (const sel of dialogButtonSelectors) {
        try {
          const btn = await driver.findElement(By.css(sel));
          if (await btn.isDisplayed()) {
            await driver.executeScript("arguments[0].click();", btn);
            await sleep(1500);
            break;
          }
        } catch {
          continue;
        }
      }
    }
  } catch {
    // No dialog, continue
  }

  // Wait for chat input (compose box)
  let input;
  const selectors = [
    'div[contenteditable="true"][data-tab="10"]',
    'div[contenteditable="true"][data-tab="1"]',
    '[data-testid="conversation-compose-box-input"]',
    'footer div[contenteditable="true"]',
    'div[contenteditable="true"]',
    'div[role="textbox"]',
  ];
  for (const sel of selectors) {
    try {
      input = await driver.wait(
        until.elementLocated(By.css(sel)),
        CHAT_READY_TIMEOUT_MS
      );
      const visible = await input.isDisplayed();
      if (visible) break;
    } catch {
      continue;
    }
  }
  if (!input) {
    report.errors.push(phone);
    return false;
  }

  // Scroll into view and use JS click to avoid "element click intercepted" by dialog/overlay
  await driver.executeScript("arguments[0].scrollIntoView({block:'center'});", input);
  await sleep(300);
  try {
    await input.click();
  } catch {
    await driver.executeScript("arguments[0].click();", input);
  }
  await sleep(300);
  for (const ch of message) {
    await input.sendKeys(ch);
    await sleep(SEND_KEY_DELAY_MS);
  }
  await sleep(500);

  // Send: click send button or press Enter
  try {
    const sendSelectors = [
      'span[data-icon="send"]',
      'button[aria-label="Send"]',
      '[data-testid="send"]',
    ];
    let sent = false;
    for (const sel of sendSelectors) {
      try {
        const btn = await driver.findElement(By.css(sel));
        await btn.click();
        sent = true;
        break;
      } catch {
        continue;
      }
    }
    if (!sent) await input.sendKeys("\n");
  } catch {
    try {
      await input.sendKeys("\n");
    } catch {
      report.errors.push(phone);
      return false;
    }
  }
  // Wait for message to actually send before returning (avoids browser closing too soon)
  await sleep(3000);
  report.sent.push(phone);
  return true;
}

async function runBot(opts, entries, defaultMessage) {
  const report = { sent: [], errors: [] };
  const chromeOptions = new chrome.Options();
  // Always use a persistent profile so WhatsApp Web stays logged in after first QR scan
  const userDataDir = opts.chromeUserData != null
    ? resolvePath(opts.chromeUserData)
    : path.join(__dirname, "whatsapp-chrome-profile");
  chromeOptions.addArguments(`--user-data-dir=${userDataDir}`);
  // Use remote debugging port to allow Chrome to run even if another instance exists
  // (though they can't share the same profile - this helps with other Chrome windows)
  chromeOptions.addArguments(`--remote-debugging-port=9222`);
  console.log("Using Chrome profile:", userDataDir, "(scan QR only on first run)\n");
  if (opts.headless) {
    chromeOptions.headless();
  }

  let driver;
  try {
    driver = await new Builder()
      .forBrowser("chrome")
      .setChromeOptions(chromeOptions)
      .build();
  } catch (error) {
    if (error.message && (error.message.includes("Chrome instance exited") || error.message.includes("session not created"))) {
      console.error("\n❌ Error: Chrome couldn't start. Common causes:");
      console.error("   1. Chrome is already running with this profile.");
      console.error("      → Close ALL Chrome windows (including regular Chrome) and try again.");
      console.error("      → Or use a different profile: --chrome-user-data ./another-profile");
      console.error("   2. The profile directory is locked.");
      console.error(`      → Try deleting it: rm -rf "${userDataDir}"`);
      console.error("      → Then run again (you'll need to scan QR once more).");
      console.error("\n   Full error:", error.message);
      process.exit(1);
    }
    throw error;
  }

  try {
    await driver.get("https://web.whatsapp.com");
    console.log("Waiting for WhatsApp Web login (scan QR if needed)...");
    console.log("If you don't see Chrome, check behind other windows or the Dock (Mac).");
    const loggedIn = await waitForLogin(driver);
    if (!loggedIn) {
      console.error("Login timeout. Please scan the QR code and run again.");
      process.exit(2);
    }
    console.log("Logged in. Starting to send...\n");

    const toSend = opts.max ? entries.slice(0, opts.max) : entries;
    for (let i = 0; i < toSend.length; i++) {
      const { phone, message } = toSend[i];
      const text = message || defaultMessage;
      console.log(`[${i + 1}/${toSend.length}] Sending to ${phone}...`);
      const ok = await sendToNumber(driver, opts.countryCode, phone, text, report);
      if (ok) {
        console.log(`  OK`);
      } else {
        console.log(`  Failed (chat may not have opened)`);
      }
      if (i < toSend.length - 1) {
        const d = opts.delay * 1000;
        console.log(`  Waiting ${opts.delay}s before next...`);
        await sleep(d);
      }
    }

    const keepOpenSec = opts.keepOpen != null ? Math.max(0, parseInt(opts.keepOpen, 10) || 5) : 5;
    console.log(`\nWaiting ${keepOpenSec}s for message(s) to deliver, then closing browser...`);
    await sleep(keepOpenSec * 1000);

    console.log("Done.");
    console.log(`Sent: ${report.sent.length}, Errors: ${report.errors.length}`);
    if (report.errors.length) {
      console.log("Failed numbers:", report.errors.join(", "));
    }
  } finally {
    await driver.quit();
  }
  return report;
}

async function main() {
  const opts = parseArgs();

  if (!opts.excel && !opts.number) {
    console.error("Usage: use --excel <file.xlsx> for bulk send, or --number <phone> for a single number.");
    console.error("  node scripts/whatsapp-selenium-bot.js --excel path/to/numbers.xlsx --message \"Your message\"");
    console.error("  node scripts/whatsapp-selenium-bot.js --number 9405679107 --message \"Your message\"");
    process.exit(1);
  }
  if (opts.excel && opts.number) {
    console.error("Use either --excel or --number, not both.");
    process.exit(1);
  }

  let defaultMessage = null;
  if (!opts.dryRun) {
    try {
      defaultMessage = loadMessage(opts);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  } else {
    defaultMessage = opts.message || "(dry-run: no message)";
  }

  let entries;
  if (opts.number) {
    const ten = normalizePhone(opts.number);
    if (!ten) {
      console.error("Invalid phone number. Use 10 digits or 12 with country code (e.g. 919405679107).");
      process.exit(1);
    }
    entries = [{ phone: ten, message: null }];
    console.log(`Single number: ${ten}. Message: "${defaultMessage.slice(0, 50)}${defaultMessage.length > 50 ? "..." : ""}"`);
  } else {
    let data;
    try {
      data = readNumbersFromExcel(
        opts.excel,
        opts.sheet,
        opts.column,
        opts.messageColumn
      );
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }

    const { entries: excelEntries, skipped, invalid } = data;
    if (invalid.length) {
      console.log(`Skipped ${skipped} invalid row(s):`, invalid.slice(0, 5));
      if (invalid.length > 5) console.log(`  ... and ${invalid.length - 5} more`);
    }
    if (excelEntries.length === 0) {
      console.error("No valid phone numbers found in Excel.");
      process.exit(1);
    }
    entries = excelEntries;
    console.log(`Found ${entries.length} valid number(s). Default message: "${defaultMessage.slice(0, 50)}${defaultMessage.length > 50 ? "..." : ""}"`);
  }

  if (opts.dryRun) {
    console.log("Dry run – not opening browser. Numbers:", entries.map((e) => e.phone).join(", "));
    process.exit(0);
  }

  const report = await runBot(opts, entries, defaultMessage);
  process.exit(report.errors.length > 0 ? 3 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
