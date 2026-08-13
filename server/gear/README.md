# Shared gear service

The docs site is a static build served by nginx, which cannot write anything
down. The signal studio's library has to be writable by the team and the same
for everyone, so it gets this: a small Node service in the same compose project.

It holds three collections: **antennas**, **radios** and **benches**, a bench
being a whole saved setup. They differ only in what a valid one looks like, so
they share one endpoint, one file and one set of rules about who may change what.

Nothing else on the site depends on it. If it is down, the studio shows the
built-in parts plus whatever this browser cached from its last visit, and
saving is disabled with a reason.

## How it is wired

It runs on the same hostname as the site, under `/api/benches`, rather than on a
subdomain. Two things follow from that, and both are the reason it is set up
this way:

- The browser treats it as **same origin**, so there is no CORS to configure and
  the session cookie goes along without being asked for.
- It sits behind the **same `authentik@file` middleware** as the site, so the
  people who can publish are exactly the people who can read the page. That is
  why there is no rate limiting or spam defence in here: it is not an open
  endpoint on the internet.

Traefik picks it over the site's own router because the rule is more specific
and the priority is set explicitly in `docker-compose.yml`.

## Running it

It comes up with everything else:

```sh
docker compose --profile prod up -d
```

To be able to remove other people's benches, put a token in a `.env` file beside
`docker-compose.yml`:

```sh
MODERATOR_TOKEN=some-long-random-string
```

Without it, everyone can still remove their own.

## Storage

One JSON file at `/data/gear.json` on the `benches-data` volume. Writes go to
a temporary file and are renamed into place, so a crash mid-write leaves the
previous catalogue intact rather than half a file.

It is a plain file on purpose. You can read it, grep it, back it up with
everything else on the host, and fix it by hand when something goes wrong.

```sh
docker compose exec gear cat /data/gear.json             # look
docker cp mrdt-gear:/data/gear.json ./gear-backup.json   # keep
```

## API

| Method | Path | Who | Does |
|---|---|---|---|
| `GET` | `/api/gear` | anyone signed in | all three collections, plus who you are |
| `POST` | `/api/gear/:kind` | anyone signed in | save one, or edit your own by passing its `id` |
| `DELETE` | `/api/gear/:kind/:id` | whoever saved it, or a moderator | remove one |
| `GET` | `/api/health` | anyone | liveness, reads the store |

`:kind` is `antennas`, `radios` or `benches`.

`by` is taken from the `X-authentik-username` header that the auth layer sets,
not from the request body, so a bench cannot be published under someone else's
name. Set `USER_HEADER` if your auth uses a different one.

## What it validates

Everything it stores, because the studio spreads a bench's `params` over its own
model parameters when loading one:

- **16 KB** per save, **2000** items per collection.
- Every parameter key is checked against an allowlist taken from the model, so a
  publish cannot set something the UI never meant to expose.
- Every field is length-capped, and gear ids must look like gear ids.
- Names and notes are stored as text and rendered as text. No HTML is stored and
  none is interpreted.

The client validates again on the way in, which is a different job: it drops any
key the model does not have, so a service that got ahead of or behind the site
cannot put nonsense into the studio.

## Promoting a bench

Saved benches are anyone's and can be removed. The ones worth keeping go in
`src/data/benches.js`, where they are reviewed, versioned and permanent, and
where they still work when this service is down. The studio's Benches tab prints
the entry ready to paste into a pull request.
