# Poplist

**Pop it in. Pick it out.**

A movie and web-series watchlist inside a 3D popcorn bucket. Add a title and its corn kernel pops into the bucket. Can't decide what to watch? Hit **Pick for me** and the bucket shakes one out.

- Add movies and web series with platform, duration and genre
- One-tap random pick, with optional quick filters when you're not in the mood
- Mark titles watched (the popcorn gets eaten) and bring favourites back for a rewatch
- Drag the bucket to spin it, tap it to toss the popcorn
- Every list has its own private link, so the same list opens on your phone and laptop

**Live:** https://apoorvagramle.github.io/poplist/

Built with plain HTML, CSS and JavaScript, [Three.js](https://threejs.org) for the 3D scene, and Firebase Firestore for syncing. No build step.

## Project layout

```
index.html            page, styles and markup
firebase-config.js    your Firebase keys go here (optional)
firestore.rules       security rules to paste into Firebase
js/app.js             everything that happens on the page
                      (your social links are at the top of the credits section)
js/liquid-glass.js    glass refraction effect for the panels
js/vendor/qrcode.mjs  QR code generator (MIT, Kazuhiko Arase)
assets/               bucket and kernel 3D models, textures, icon
```

## 1. Put it on GitHub Pages (free)

1. Create a new repository on GitHub, for example `poplist`.
2. Upload everything in this folder to it (drag the files into the repo's "Add file → Upload files" page, or push with git).
3. In the repo, go to **Settings → Pages**. Under "Build and deployment", pick **Deploy from a branch**, choose `main` and `/ (root)`, and save.
4. After a minute your site is live at `https://<your-username>.github.io/poplist/`.

At this point it already works, but every list is saved in that one browser only.

## 2. Turn on syncing with Firebase (free, about 5 minutes)

This lets the same private link show the same list on any device. Nobody has to sign in.

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and **Create a project**. You can switch Google Analytics off.
2. In the left menu open **Build → Firestore Database → Create database**.
   - Location: `asia-south1 (Mumbai)` is closest for India.
   - Start in **production mode**.
3. Open the **Rules** tab, replace everything with the contents of `firestore.rules`, and click **Publish**.
4. Go to **Project settings** (gear icon) → **Your apps** → click the web icon `</>`. Give it any nickname, skip Hosting, and click **Register app**.
5. Firebase shows a `firebaseConfig = { ... }` block. Copy it into `firebase-config.js`, replacing `null`:

   ```js
   export const firebaseConfig = {
     apiKey: "...",
     authDomain: "...",
     projectId: "...",
     storageBucket: "...",
     messagingSenderId: "...",
     appId: "..."
   };
   ```
6. Commit the change. GitHub Pages redeploys on its own.

The config values are meant to be public. What people can and can't do is controlled by `firestore.rules`.

## How the private link works

- The first time someone opens the site, the page makes a random code and adds it to the address, like `.../poplist/#k7Qm2xPaR4tV9wZc3nHe`.
- That code is the key to their list. Opening the same link on another device shows the same list, and changes sync live.
- Someone opening the plain site address gets a brand-new list of their own.
- Find your link any time under **Your list → Your private link**. There's a Copy button and a QR code to scan with your phone.
- Want a fresh list on the same browser? **Your list → Start a new list**. Copy your current link first if you want to come back to the old one.
- Anyone who has your link can see and edit your list, so only share it with people you'd share a watchlist with. If you lose the link on every device, the list can't be found again.

## Hosting your own copy

Fork or download the repo, then either set `firebase-config.js` back to `null` (lists stay in each browser) or point it at your own Firebase project using the steps above. Please don't keep the original config in your copy, or your site's lists will be stored in someone else's Firebase.

To change the social icons in the list footer, edit `SOCIAL_LINKS` near the top of the credits section in `js/app.js`.

## Free limits

Firebase's free Spark plan allows 50,000 reads and 20,000 writes a day, which is far more than a personal watchlist or a group of friends will use. You won't be charged unless you upgrade the plan yourself.

## Credits

- Made by [Apoorva Gramle](https://github.com/apoorvagramle)

- Popcorn bucket and kernel models prepared in Blender
- [Three.js](https://threejs.org) (MIT)
- [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT)
- Social icons from [Font Awesome Free](https://fontawesome.com) (CC BY 4.0)
- Liquid glass effect adapted from [liquid-glass](https://github.com/deepika-builds/liquid-glass) (MIT)
