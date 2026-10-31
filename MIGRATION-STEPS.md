# Upgrading the cloud database (one document per record)

Do this in the evening or on a weekend, when nobody else is using the app.

## Before you start
1. Download a backup: Settings > Download backup (.json). Keep it somewhere safe.
2. Optional but recommended: run steps 3 to 8 first on a spare Firebase project (create a second free project,
   put its config in `firebase-config.js`, sign in, then Settings > Restore backup with your .json file).

## Steps
1. **Update the Firestore rules.** Firebase console > Firestore Database > Rules.
   Easiest: change `match /ikhlas_school/main {` to `match /ikhlas_school/{document=**} {` and click Publish.
   (`firestore.rules` is a complete file for reference. Keep your own `usage_meter` rule if you already have one.)
2. **Upload the new files** to your site: `app.js`, `sw.js`, `firebase-config.js` (only the comment changed; keep your own keys), `README.md`.
3. **Tell everyone to close the app**, then open it once yourself and sign in. It still works exactly as before
   (it is in "old layout" mode until you upgrade).
4. Log in as **Management** > **Settings**. You will see a **Cloud database upgrade** panel.
5. Press **Upgrade cloud database**, tick the box, press **Start upgrade**. A backup file downloads automatically.
6. Wait for the messages to finish. You should see "Verified: every document matches the source" and "Done".
   If anything fails, it says so, and **nothing is switched over**; your data is unchanged and you can try again.
7. Press **Reload now**. Settings now shows **Cloud database layout (schema 2)**. Press **Verify cloud data** once.
8. Other devices reload into the new layout by themselves the next time they are open.

## Afterwards
- Keep the old document `ikhlas_school/main` for a few weeks. The app no longer uses or changes it.
- If something goes wrong in the first days, tell me before deleting anything. Going back means redeploying the old
  `app.js` and `sw.js`; the old document is still there.
- Check Settings > usage meter for the first few days. Opening the app on a brand-new device reads every document once
  (about one read per record); after that, the offline cache means only changed records are read.
