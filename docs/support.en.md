# Agent Steward App: Help and Support

[繁體中文](support.md)

Agent Steward turns the work of the AI agents on your computer into one board: proposals, in progress, blocked, and done. The mobile app lets you follow progress, approve work, ask the steward questions, and read code when you are away from your computer, and it notifies you when something needs your attention.

## Getting started

1. **Install Agent Steward on your computer** with the desktop app described in the [README](../README.en.md). The app does not include the steward itself, so a computer running it is required.
2. **Make your computer reachable from your phone.** We recommend installing [Tailscale](https://tailscale.com/) on both and signing in with the same account. In the steward on your computer, open Settings → Access and turn on Tailscale access. You will see an address like `https://your-computer.xxxx.ts.net:8793/`.
3. **Enter that address in the app.** Over Tailscale the steward recognizes you automatically; over other connections you enter the steward's admin password.
4. **Allow notifications** (optional) to hear about new proposals, blocked cards, and finished work. Notifications are end-to-end encrypted; see the [privacy policy](privacy.en.md).

To look around first, tap "Try the demo" on the address screen. It shows every screen with sample data and needs no computer.

## Common problems

**"A server with the specified hostname could not be found"**
Your phone cannot look up the `ts.net` address. Open the Tailscale app on your phone, make sure it is connected, turn on "Use Tailscale DNS" in its settings, then switch Tailscale off and on. Open the same address in Safari to test; if you see the steward's web page, it is fixed.

**The app cannot connect, but the address is correct**
Make sure the computer is on and not asleep, and that the steward is running (opening `http://127.0.0.1:8791` on the computer shows the board).

**No notifications arrive**
- Check that notifications are on for this app in your phone's Settings → Notifications.
- In the steward on your computer, open Settings → Notifications, make sure the push relay address is not empty, and tap "Send a test push to phone".
- After updating the app or switching stewards, fully close the app and open it again so it registers again.

**Notifications only say "Agent Steward: You have a new notification"**
Your phone could not decrypt the notification, usually after switching phones or reinstalling the app. Fully close the app and open it again; it creates a new key and registers again.

## Reporting a problem

Open an issue on [GitHub Issues](https://github.com/hao-github-0216/agent-steward/issues) with your phone model, OS version, app version (at the bottom of the app's Settings), and the message you saw. Please do not post your steward address, password, or project content in the issue.
