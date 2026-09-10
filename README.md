# Seahawks Agent

Auto-posts live Seattle Seahawks commentary to Bluesky, with a password-gated
dashboard where every post is approved, edited, or rejected before it goes out.

Adapted from the Blue Jays / MLB version of this agent — same architecture,
swapped onto the NFL.

## How it works

1. **Poll** ESPN's public NFL endpoints for this week's Seahawks game.
   - `scoreboard` (cheap) for score, quarter and clock.
   - `summary?event={id}` for `boxscore.drives`, which carries the play-by-play
     needed for down & distance, possession, and key-play detection.
2. **Parse** game state — score, quarter, clock, down & distance, who has the
   ball, red zone.
3. **Detect** key moments and whether they're *good for Seattle*. A sack or a
   forced turnover is a win for Seattle even though Seattle doesn't have the
   ball, which the baseball version never had to reason about.
   Priority: Touchdown > Interception > Fumble > Blocked Kick > Field Goal >
   Safety > Sack > Big Play (20+ yards).
4. **Generate** the post text with the Anthropic API, in a Seahawks-fan voice.
5. **Hold for approval** on the dashboard. Nothing posts automatically.
6. **Post** to Bluesky via the AT Protocol XRPC endpoints.

Capped at `MAX_POSTS = 7` per game. After a game goes final the agent stands
down and starts watching for next week's matchup.

## Polling cadence

| Phase     | Interval |
| --------- | -------- |
| `waiting` | 5 min    |
| `preview` | 1 min    |
| `live`    | 30 sec   |
| `final`   | 5 min    |

## Environment variables

| Variable             | Required | Default               | Notes                                      |
| -------------------- | -------- | --------------------- | ------------------------------------------ |
| `ANTHROPIC_API_KEY`  | yes      | —                     | Writes the post text                       |
| `ANTHROPIC_MODEL`    | no       | `claude-sonnet-5`     | Model that writes the post text             |
| `BLUESKY_USERNAME`   | yes      | —                     | Handle or email                            |
| `BLUESKY_PASSWORD`   | yes      | —                     | Use an **app password**                    |
| `BLUESKY_HANDLE`     | no       | `likeablechelsey.com` | Handle used for attribution                |
| `DASHBOARD_PASSWORD` | no       | `gohawks`             | Gates the approval dashboard               |
| `PORT`               | no       | `3000`                | Railway sets this automatically            |

## Running locally

```bash
npm install
cp .env.example .env   # then fill it in
node --env-file=.env seahawksagent.js
```

The dashboard is at `http://localhost:3000`.

## Deploying

Deployed on Railway, building from this repo's `main` branch. Set the
environment variables above in the Railway service, and the agent runs as a
long-lived process — no cron needed, it polls on its own.

## Data source caveat

ESPN's NFL endpoints are public but unofficial and undocumented. They need no
API key, but field names can change without notice. The parser was written
against real live responses rather than assumed shapes, and the key ones are
`play.sequenceNumber` (used to sort plays chronologically across drives, since
drive order isn't guaranteed), `play.start` / `play.end`, `play.scoringPlay`,
`play.isTurnover`, and `play.statYardage`.
