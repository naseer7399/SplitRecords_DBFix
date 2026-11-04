# Automatic backup to Google Drive: one-time setup

A scheduled GitHub job reads your school database every 6 hours. When a backup is due (the schedule you pick in the app:
every day, week, 15 days or month) it saves one file to a private folder called **Ikhlas School Backups** in Google Drive.
It runs even when nobody has the app open. Estimated time for the setup: 30 to 40 minutes, once.

## Read this first (security)
- **Never give your Google password to anyone**, including me, and never put it in a file. This setup does not need it.
  You approve access once on Google's own page, and Google gives GitHub a limited-access key instead.
- A backup file contains **Aadhaar numbers and the in-app passwords**. Use a **dedicated school Google account** with
  **2-step verification**, and never share the backup folder.
- The two keys below (Firebase key, Google key) go **only** into GitHub "Secrets". Never paste them into app.js,
  firebase-config.js, chat, email or WhatsApp. If one leaks, delete it in Firebase/Google and make a new one.
- The job never prints student data, and never uploads backups as GitHub "artifacts" (those can be public in a public repository).

## What you need
- The GitHub repository that holds your school app (any one repository is enough, even if you have two websites).
- Admin access to your Firebase project (iks-1-4v-db) and the school Google account.

## Part 1: add the files to your repository
1. Upload the new **app.js** (replaces the old one) and the whole **backup** folder (lib.js, run.js, package.json, package-lock.json, test.js).
2. Add **drive-backup.yml** as `.github/workflows/drive-backup.yml`. On the GitHub website: Add file > Create new file, type
   `.github/workflows/drive-backup.yml` as the name, paste the contents, and commit to the default branch (usually `main`).
3. Deploy as usual. In the app, Settings now has **Automatic backup to Google Drive**.

## Part 2: Firebase key (lets the job read your data)
1. Firebase console > the gear icon > **Project settings** > **Service accounts** tab.
2. Press **Generate new private key** > Generate. A `.json` file downloads.
3. Open that file in Notepad and copy **everything** in it.
4. In GitHub: your repository > **Settings** > **Secrets and variables** > **Actions** > **New repository secret**.
   Name: `FIREBASE_SERVICE_ACCOUNT`. Value: paste everything. Save.
5. **Delete the downloaded .json file** from your computer (empty the recycle bin). It is full access to your database.

## Part 3: Google Drive approval (lets the job save files to your Drive)
Use the school Google account for all of this. Google's screens change names now and then; follow the idea if a label differs.
1. Go to **console.cloud.google.com**, create a project (for example "Ikhlas Backup").
2. **APIs & Services** > **Library** > search **Google Drive API** > **Enable**.
3. **OAuth consent screen** (also called "Google Auth Platform"): choose **External**, give an app name ("Ikhlas Backup") and your email.
   Under **Data access** / scopes add: `https://www.googleapis.com/auth/drive.file`
   Then **publish the app** (status "In production"). **Important:** if it stays in "Testing", Google cancels the approval after 7 days
   and backups stop. Publishing is allowed without review because this permission only lets the app touch files it creates itself.
4. **Credentials** > **Create credentials** > **OAuth client ID** > type **Web application**. Under **Authorized redirect URIs** add exactly:
   `https://developers.google.com/oauthplayground`
   Create it, then copy the **Client ID** and **Client secret**.
5. Open **https://developers.google.com/oauthplayground**. Click the **gear icon** (top right), tick **Use your own OAuth credentials**,
   paste the Client ID and Client secret.
6. In the left box "Input your own scopes" type `https://www.googleapis.com/auth/drive.file` and press **Authorize APIs**.
   Sign in with the school account and press Allow. (If it says "Google hasn't verified this app", choose Advanced > continue: it is your own app.)
7. Press **Exchange authorization code for tokens**. Copy the **Refresh token** (a long text starting with `1//`).
8. Add three more GitHub secrets (same place as Part 2): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`.

## Part 4: first backup and schedule
1. GitHub > **Actions** tab > **Drive backup** > **Run workflow** (leave "Back up now" ticked) > Run. Open the run and watch the log.
   Success looks like: `Uploaded ikhlas-school-backup-... and verified its checksum.`
2. Open Google Drive: the folder **Ikhlas School Backups** now holds your backup file.
3. In the app: **Settings > Automatic backup to Google Drive**, choose **Every day / week / 15 days / month**, press **Save schedule**.
   **Refresh status** shows the last backup. **Back up now** asks for a backup at the next check (within about 6 hours),
   or start it immediately from GitHub (step 1).

## How it behaves
- It checks every 6 hours. A "daily" backup therefore happens within a few hours of the 24-hour mark. Monthly means every 30 days.
- It keeps the newest **30** backups and deletes only older files that it created itself, inside its own folder. To keep a different number,
  change `BACKUP_KEEP` in drive-backup.yml.
- If the school data suddenly looks much smaller than at the last backup (for example most students missing), it still saves that file
  but **deletes nothing** and shows a warning in the app.
- Every upload is verified (size and checksum) before anything old is removed.
- Size: about 1 MB per backup for a school of 450 students, so 30 backups is roughly 30 MB of Drive space.
- Cost: free. About 4 tiny checks a day (one database read each) plus about 700 reads on a backup day, well inside Firebase's free limit.
  GitHub Actions is free for public repositories; a private repository uses a small part of its free monthly minutes.

## Restoring a backup
Download the file from Drive, then in the app: **Settings > Restore from backup** and choose it. This replaces all current data,
so try it first on a test project. The file format is the same as the app's own "Download backup".

## If something goes wrong
| What you see | What to do |
|---|---|
| App shows **Backups look overdue** or **The last attempt failed** | GitHub > Actions > Drive backup > open the latest run to read the reason. GitHub also emails the person who set the schedule when a run fails. |
| `invalid_grant` | Google no longer accepts the saved approval: the Google Cloud app was left in "Testing", or access was revoked. Publish the app (Part 3, step 3) and repeat steps 5 to 8 to get a new refresh token. |
| `Missing GitHub secret(s)` | One of the four secrets is missing or misspelled (names are exact). |
| `Drive is full` | Free some space in the school Google account, or lower `BACKUP_KEEP`. |
| Permission denied / wrong project | The Firebase key must be from the same project the app uses (iks-1-4v-db). |
| No runs for a long time | GitHub pauses scheduled jobs in public repositories after 60 days without activity. The last step of the job tries to prevent this, but if it happens press **Run workflow** once to restart it. The app's "overdue" warning will tell you. |

## For the curious: what is in the repository
`backup/lib.js` is the backup logic, `backup/run.js` starts it, `backup/test.js` checks it (run `npm test` inside the backup folder).
`drive-backup.yml` is the schedule. The schedule you choose in the app is stored in your database in `ikhlas_school/backup`.
