<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/f771455a-0890-4937-b823-43adb3035798

## Run locally

**Prerequisites:** Node.js 22 or later


1. Install dependencies:
   `npm install`
2. Set `ADMIN_PASSWORD_HASH` in `.env.local` using the output of:
   `node scripts/hash-admin-password.mjs "your-password"`
3. Optionally set `GEMINI_API_KEY` in `.env.local` for Gemini API calls.
4. Run the app:
   `npm run dev`

The admin password is verified by the server and is never embedded in the web page. Local development stores data in `.data/site-data.json` and uses HttpOnly admin session cookies.

## Deploy to Firebase

The production setup uses Firebase Hosting for the site, Cloud Functions for the protected admin API, and Cloud Firestore for shared site data and admin sessions. Firestore client access is denied; the API accesses it through the Cloud Functions service account. Cloud Functions deployments require the Firebase project to use the Blaze billing plan.

The Firebase project is configured as `thai-textile-atlas`; the Functions and Firestore database both use the `asia-southeast3` region. Before the first deployment:

1. Install the Cloud Functions dependencies with `npm install --prefix functions`.
2. In Firebase Console, confirm that billing is enabled for Blaze and that Firestore is available in the configured region.
3. Set the server-side password hash as a Firebase secret. Use the existing local hash without printing it:

   ```powershell
   $line = Select-String -Path .env.local -Pattern '^ADMIN_PASSWORD_HASH=' | Select-Object -First 1
   if (-not $line) { throw 'ADMIN_PASSWORD_HASH is missing from .env.local' }
   $hash = ($line.Line -replace '^ADMIN_PASSWORD_HASH=', '').Trim().Trim('"').Trim("'")
   $hash | firebase functions:secrets:set ADMIN_PASSWORD_HASH --project thai-textile-atlas --data-file -
   Remove-Variable hash, line
   ```

4. Deploy the site, API, and Firestore security configuration:

   ```powershell
   npm run build
   firebase deploy --project thai-textile-atlas
   ```

The initial deployment is available at `https://thai-textile-atlas.web.app`. To migrate the current local `.data/site-data.json` into Firestore after deployment, set `ADMIN_PASSWORD` in the shell to the existing admin password and run:

```powershell
node scripts/migrate-data-to-firebase.mjs
Remove-Item Env:ADMIN_PASSWORD
```

The migration script only prints record counts and never prints the password or session cookie. To deploy only the frontend later, run `npm run build` followed by `firebase deploy --only hosting --project thai-textile-atlas`.
