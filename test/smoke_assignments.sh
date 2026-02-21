#!/bin/bash
# Simple smoke test for assignments endpoints (requires curl)
#
# Usage:
#   chmod +x smoke_assignments.sh
#   ./smoke_assignments.sh
#
# This script performs basic unauthenticated checks. For authenticated checks,
# set AUTH_HEADER="Authorization: Bearer <token>" before running.

API_BASE="${API_BASE:-http://localhost:8000}/api/v1"

echo "1) GET /assignments (expect 401 or auth-required)"
curl -s -i "${API_BASE}/assignments?filter=current"
echo -e "\n\n2) POST /assignments (expect 401 or auth-required)"
curl -s -i -X POST "${API_BASE}/assignments" -H "Content-Type: application/json" -d '{"phone":"9999999999","scheduledAt":"2026-03-01T10:00:00Z","notes":"smoke test"}'
echo -e "\n\nDone."

