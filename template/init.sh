#!/usr/bin/env bash
# {{projectName}} -- Development Environment Setup
# This script is idempotent -- safe to re-run at any time.
# Run it at the start of every agent session to ensure deps are current.

set -euo pipefail

echo "========================================"
echo "  {{projectName}} -- Dev Environment Setup"
echo "========================================"
echo ""

# ------------------------------------------
# 1. Check required tools
# ------------------------------------------
echo "Checking required tools..."

check_tool() {
  if ! command -v "$1" &> /dev/null; then
    echo "ERROR: $1 is not installed. Please install it before continuing."
    exit 1
  fi
}

check_tool node
check_tool npm
check_tool git

# Check Node.js version (need >= 18)
NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "ERROR: Node.js >= 18 required. Current: $(node -v)"
  exit 1
fi

echo "  node: $(node -v)"
echo "  npm:  $(npm -v)"
echo "  git:  $(git --version)"
echo ""

# ------------------------------------------
# 2. Install dependencies (root workspace)
# ------------------------------------------
echo "Installing dependencies..."

if [ -f "package.json" ]; then
  npm install
else
  echo "WARNING: No package.json found at project root."
  echo "  If this is the initializer session, you need to scaffold the project first."
fi

echo ""

# ------------------------------------------
# 3. Install sub-package dependencies
# ------------------------------------------
if [ -d "functions" ] && [ -f "functions/package.json" ]; then
  echo "Installing function dependencies..."
  (cd functions && npm install)
  echo ""
fi

# ------------------------------------------
# 4. Generate Prisma client (if applicable)
# ------------------------------------------
if [ -f "prisma/schema.prisma" ]; then
  echo "Generating Prisma client..."
  npx prisma generate
  echo ""
else
  echo "NOTE: prisma/schema.prisma not found yet. Skipping Prisma generate."
  echo ""
fi

# ------------------------------------------
# 5. Set up environment file
# ------------------------------------------
if [ -f ".env.example" ] && [ ! -f ".env.local" ]; then
  echo "Creating .env.local from .env.example..."
  cp .env.example .env.local
  echo "  IMPORTANT: Edit .env.local with your actual credentials."
  echo ""
elif [ -f ".env.local" ]; then
  echo ".env.local already exists -- skipping copy."
  echo ""
fi

# ------------------------------------------
# 6. Run database migrations (if applicable)
# ------------------------------------------
if [ -f "prisma/schema.prisma" ] && [ -f ".env.local" ]; then
  echo "Pushing database schema..."
  npx prisma db push --skip-generate 2>/dev/null || {
    echo "NOTE: prisma db push failed. This is expected if DATABASE_URL is not configured."
  }
  echo ""
fi

# ------------------------------------------
# 7. Status summary
# ------------------------------------------
echo "========================================"
echo "  Setup Summary"
echo "========================================"
echo ""
echo "  Node.js:     $(node -v)"
echo "  npm:         $(npm -v)"

if [ -f "package.json" ]; then
  echo "  Root deps:   installed"
else
  echo "  Root deps:   NOT FOUND (need package.json)"
fi

if [ -f "prisma/schema.prisma" ]; then
  echo "  Prisma:      schema found"
else
  echo "  Prisma:      no schema yet"
fi

if [ -f ".env.local" ]; then
  echo "  Environment: .env.local exists"
else
  echo "  Environment: NO .env.local (create from .env.example)"
fi

echo ""
echo "  To start dev server:  ./scripts/dev-up.sh"
echo "  To run tests:         npm test"
echo "  To check types:       npx tsc --noEmit"
echo ""
echo "========================================"
echo "  Ready!"
echo "========================================"
