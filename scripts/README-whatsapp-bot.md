# WhatsApp Selenium Bot (Excel → WhatsApp Web)

This script sends WhatsApp messages to phone numbers read from an Excel file. It uses **Selenium** to automate **WhatsApp Web** in a browser. It does **not** use the WATI API.

## Prerequisites

- Node.js (project already uses `xlsx` and `selenium-webdriver`)
- Chrome or Chromium installed (Selenium will use it automatically)
- An Excel file with at least one column containing phone numbers

## Usage

From the project root (`FINAL_NURSERY_BE`):

**Single number:**
```bash
node scripts/whatsapp-selenium-bot.js --number 9405679107 --message "Your message here"
```

**Bulk from Excel:**
```bash
node scripts/whatsapp-selenium-bot.js --excel path/to/numbers.xlsx --message "Your message here"
```

Or via npm script:

```bash
npm run whatsapp-bot -- --number 9405679107 --message "Hello"
npm run whatsapp-bot -- --excel path/to/numbers.xlsx --message "Your message here"
```

### Required (one of)

- **--excel** `<path>` – Path to the Excel file for bulk send (e.g. `fetch-excel/numbers.xlsx` or absolute path).
- **--number** `<phone>` – Single phone number (10 digits, or with country code e.g. 919405679107). Use instead of `--excel` to send to one contact.

Plus a message:

- **--message** `<text>` – Message to send.  
  Alternatively use **--message-file** `<path>` to read the message from a text file.

### Optional

- **--column** `<name>` – Excel column name for phone numbers (e.g. `Mobile`, `Phone`).  
  If omitted, the script looks for columns named `Mobile`, `Phone`, `mobileNumber`, `WhatsApp`, or `Contact`, or the first header matching “mobile” / “phone” / “whatsapp” / “contact”.
- **--message-column** `<name>` – If your Excel has a column with a different message per row, set its name here. Rows without a value use the default `--message`.
- **--sheet** `<name>` – Sheet name (default: first sheet).
- **--country-code** `<code>` – Country code without `+` (default: `91`).
- **--delay** `<seconds>` – Pause between each send (default: `10`). Use a higher value to reduce risk of limits.
- **--max** `<n>` – Send to at most this many numbers in one run.
- **--chrome-user-data** `<dir>` – Chrome user data directory (e.g. `./whatsapp-profile`). Reusing the same directory keeps the WhatsApp Web session so you don’t need to scan the QR code every time.
- **--keep-open** `<seconds>` – Keep the browser open for this many seconds after sending (default: 5) so the message can deliver before closing.
- **--headless** – Run Chrome in headless mode (not recommended for first login; QR scan needs a visible window).
- **--dry-run** – Only read Excel and print numbers and message; do not open the browser.

## Excel format

- One column must contain phone numbers (10 digits, or 12 with `91` prefix for India).
- Numbers can contain spaces, dashes, or commas; the script normalizes them.
- Invalid or empty rows are skipped and reported.

Example:

| Name   | Mobile      | Message (optional)   |
|--------|-------------|-----------------------|
| Farmer1| 9405679107  | Hello Farmer1        |
| Farmer2| 91 9123456789| Hi                    |

## First run (QR code)

1. Run the script with `--excel` and `--message` (or `--number` for a single contact).
2. A Chrome window will open to WhatsApp Web. The script uses a **default persistent profile** (`scripts/whatsapp-chrome-profile/`) so the session is saved.
3. **First time only:** scan the QR code with your phone (WhatsApp → Linked Devices).
4. After login, the script will start sending. On the next run, Chrome will open already logged in (no QR).

## Staying logged in (default)

The script **always** uses a persistent Chrome profile so you don’t have to scan the QR code every time:

- **Default profile:** `scripts/whatsapp-chrome-profile/` (created automatically). First run: scan QR once. Later runs: already logged in.
- **Custom profile:** use `--chrome-user-data ./my-profile` to choose another folder. Use the same folder every time to keep the session.

## Disclaimer

- This tool automates WhatsApp Web. Automation may conflict with WhatsApp’s Terms of Service. Use only for legitimate, consented contacts (e.g. your own list of opted-in users).
- The script does **not** use WATI or any external WhatsApp API; it only drives the browser.

## Troubleshooting

- **“No valid phone numbers found”** – Check the Excel column name and that numbers are 10 digits (or 12 with country code). Use `--column` if your header is different.
- **Login timeout** – Ensure you scan the QR code within the wait time. Run without `--headless` for first login.
- **Chat doesn’t open / send fails** – WhatsApp Web’s HTML may change; the script uses common selectors. If WhatsApp updates their layout, selectors in `whatsapp-selenium-bot.js` may need to be updated.
- **Chrome not found** – Install Chrome or Chromium. On some systems you may need to set the Chrome binary path in the script or use a different driver.
