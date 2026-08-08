#!/bin/bash
cd "$(dirname "$0")"
mkdir -p db uploads
[ -f .env ] || cp .env.example .env
npm install
npm run seed
npm start
