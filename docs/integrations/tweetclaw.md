# TweetClaw Community Integration

TweetClaw is a separately maintained OpenClaw plugin for X/Twitter workflows.
Use it beside AnchorClaw when an OpenClaw workspace needs to scrape tweets,
search tweets, search tweet replies, export followers, look up users, monitor
tweets, deliver webhooks, run giveaway draws, or prepare reviewed post/reply
actions.

This is a community integration note. AnchorClaw does not maintain TweetClaw,
Xquik, or their package/release process.

## Install

```bash
openclaw plugins install @xquik/tweetclaw
openclaw config set plugins.entries.tweetclaw.config.apiKey "$XQUIK_API_KEY"
openclaw config set tools.alsoAllow '["explore", "tweetclaw"]'
```

Review third-party plugin source, package metadata, and approval boundaries
before installing it in a workspace that stores sensitive memory.

## Source Memory Pattern

Use TweetClaw for collection and AnchorClaw for concise, durable source notes:

1. Run a TweetClaw search, reply search, follower export, user lookup, monitor,
   webhook, giveaway draw, media, or post/reply workflow.
2. Store only a short AnchorClaw memory record with the query, capture date,
   tweet IDs or URLs, author handles, counts, summary, decision, and follow-up
   action.
3. Retrieve the note later with `memory_search(corpus="memory")` or
   `memory_recall`.

Keep raw timelines, direct messages, private account material, cookies, API
keys, exported files, and webhook payloads out of durable memory. Store the
Xquik API key in local OpenClaw config or an approved secret manager.

## Links

- TweetClaw GitHub repository: https://github.com/Xquik-dev/tweetclaw
- TweetClaw npm package: https://www.npmjs.com/package/@xquik/tweetclaw
