#!/usr/bin/env bash
# Generate RSA 4096 key + X.509 public certificate for ICICI Corporate API.
# Usage (from FINAL_NURSERY_BE root):
#   bash scripts/generate-icici-cert.sh
#   bash scripts/generate-icici-cert.sh /path/to/keys   # custom dir

set -euo pipefail

KEY_DIR="${1:-./keys}"
mkdir -p "$KEY_DIR"

PRIVATE_KEY="$KEY_DIR/private.key"
PUBLIC_CRT="$KEY_DIR/public.crt"

echo "==> Generating RSA 4096 private key: $PRIVATE_KEY"
openssl genrsa -out "$PRIVATE_KEY" 4096
chmod 600 "$PRIVATE_KEY"

echo "==> Generating X.509 public certificate (365 days): $PUBLIC_CRT"
openssl req -new -x509 -key "$PRIVATE_KEY" -out "$PUBLIC_CRT" -days 365 \
  -subj "/C=IN/ST=Maharashtra/O=RamBiotech/OU=ERP/CN=erp-icici-banking"

echo ""
echo "Done."
echo "  KEEP SECRET:  $PRIVATE_KEY"
echo "  SHARE WITH ICICI (Registration API): $PUBLIC_CRT"
echo ""
echo "Download ICICI bank public cert from ICICI portal → save as:"
echo "  $KEY_DIR/icici_public.crt"
echo ""
echo "Add to .env:"
echo "  ICICI_PRIVATE_KEY_PATH=./keys/private.key"
echo "  ICICI_PUBLIC_CERT_PATH=./keys/public.crt"
echo "  ICICI_BANK_PUBLIC_CERT_PATH=./keys/icici_public.crt"
