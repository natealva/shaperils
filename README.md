# ðº Shaperils

**Rally the crew to Shays â every day in April 2026.**

Shaperils is a web app that tracks your Shays bar attendance with selfie check-ins, sends SMS alerts to rally the crew, and keeps a leaderboard of who's showing up.

## Features

### ð¸ Selfie Check-In
- Take a selfie at Shays to log your attendance for the day
- Camera capture or photo upload
- One check-in per day (no double-dipping)
- Sends a notification to the group when someone checks in

### ð April Calendar
- Visual calendar of all April 2026 weekdays
- Green = you showed up, Red = you missed it
- Filter by any person to see their attendance

### ð Leaderboard
- Ranked by total check-ins
- Shows current streak and missed days
- Progress bar for each person

### ð£ Rally Alerts (SMS via Twilio)
- "I'm heading to Shays now!"
- "Going solo â please join!"
- "Going with [friends]"
- "Who wants to go to Shays?"
- Custom message

### ð Persistent Login
- Sign in with name + phone number
- Your device remembers you (localStorage token)
- SMS subscription included automatically

## Quick Start

```bash
git clone https://github.com/YOUR_USERNAME/shaperils.git
cd shaperils
npm install
cp .env.example .env    # Fill in Twilio creds (optional for demo mode)
npm start
```

Open [http://localhost:3000](http://localhost:3000).

## Twilio Setup (Optional)

Without Twilio credentials, the app runs in **demo mode** â SMS messages are logged to the console but not actually sent. To enable real SMS:

1. Sign up at [twilio.com](https://www.twilio.com)
2. Get your Account SID, Auth Token, and a phone number
3. Add to `.env`:

```env
TWILIO_ACCOUNT_SID=ACxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_PHONE_NUMBER=+1XXXXXXXXXX
```

## Tech Stack

- **Backend:** Node.js + Express
- **Database:** JSON file store (zero dependencies)
- **SMS:** Twilio API
- **Frontend:** Vanilla HTML/CSS/JS (no build step)
- **Selfies:** Base64 upload, stored on disk

## Deployment

Deploy anywhere that runs Node.js:

- **Railway** â connect repo, set env vars, done
- **Render** â Web Service, Node environment
- **Fly.io** â `fly launch`
- **Heroku** â `git push heroku main`

Note: For persistent selfie storage in production, consider adding S3 or similar object storage.

## April 2026

Shays. Every weekday. No excuses. ðº
