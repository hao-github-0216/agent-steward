# Agent Steward Privacy Policy

[繁體中文](privacy.md)

Last updated: November 15, 2026

Agent Steward is open-source software that you install and run on your own computer. The iPhone, iPad, and Android apps connect only to **your own** steward, never to a server run by the developer. The one exception is described under "Push notifications" below.

## What we don't collect

- No accounts, names, email addresses, or other personal information.
- No analytics, no ads, and no tracking of what you do in the app.
- Your projects, files, cards, and conversations stay on your own computer. The developer never receives them.

## Where the app connects

| Destination | When | What is sent |
|---|---|---|
| Your own Agent Steward (the address you enter, usually a Tailscale `ts.net` address) | Every screen of the app | Everything you see and do in the app. This data travels only between your phone and your computer |
| The push relay (a service the developer runs on Cloudflare) | After you allow notifications, whenever your steward needs to notify you | See "Push notifications" below |
| cdn.jsdelivr.net | When you preview a Markdown file or view math in the app | An ordinary web request (your IP address) to download open-source formatting libraries. File contents are never sent |

Demo mode connects to nothing. All of its data is built-in sample data.

## Push notifications

Apple and Google only deliver notifications to an app when they are sent with the developer's own key, so notifications have to pass through a push relay that the developer runs. It is designed so that the relay cannot read them:

1. When you first allow notifications, your phone generates its own encryption key and gives it, together with the device's push token, to **your own** steward. The key is never sent anywhere else.
2. When your steward needs to notify you, it encrypts the title and text with that key (AES-256-GCM) and hands the encrypted message to the push relay.
3. The relay passes the encrypted message to Apple (iPhone, iPad) or Google (Android). Your phone decrypts it before showing it.

The push relay, Apple, and Google can therefore see **only** the device push token, the platform (iOS or Android), the encrypted message, and the IP address the request came from. They cannot see the notification text, project names, or links.

The push relay stores nothing. Its logs record only the platform, the status code from Apple or Google, and how long the request took, never the push token or the content. The relay's source code is public in [relay/](../relay/).

You can turn notifications off at any time in iOS or Android Settings, or clear the push relay address under Settings → Notifications in your steward to switch this path off.

## Camera and photos

The app uses the camera and photo library only when you choose to take or pick a photo. The photo is sent only to your own steward, attached to your question or uploaded file.

## AI services you set up on your computer

When you ask the steward a question or let an agent work, your steward sends the relevant project content to the AI service you chose under Settings → AI providers (for example your own account, or a model you host yourself). That exchange happens between the steward on your computer and that service. Neither the app nor the developer is involved, and the service's own privacy policy applies.

## Children

This app is a tool for software developers and is not designed for children under 13.

## Contact and changes

Please send questions through [GitHub Issues](https://github.com/hao-github-0216/agent-steward/issues). When this policy changes, the date above is updated and the change is recorded in this file's Git history.
