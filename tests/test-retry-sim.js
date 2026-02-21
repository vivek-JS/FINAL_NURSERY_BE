const MAX_ATTEMPTS = 5;
const BASE_DELAY_SEC = 10;

function nextDelay(attempts) {
  return BASE_DELAY_SEC * Math.pow(2, attempts - 1);
}

for (let attempts = 1; attempts <= 6; attempts++) {
  const d = nextDelay(attempts);
  console.log(`Attempt ${attempts} -> delay ${d}s`);
}

