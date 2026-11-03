# PlanItVibe application requirements

Source of truth for Grok Build CLI and Git.  
Word review copy: `PlanItVibe-requirements.docx` (comments stay there until each item is closed).  
Historical only: `reuirements.md` (5 October 2025 snapshot).

This file was rebuilt 28 September 2026 from the 25 September Word snapshot, plus section 12 (app configuration) and locked naming/role decisions from 25–26 September.

---

## 1. Product

PlanItVibe is a collaborative planning app for trips and other occasions (conference, wedding weekend, reunion). People share one plan, an itinerary of timed activities, and roles.

The live API and models use **plan**, not trip: `/api/plans`, `Plan`, `PlanUser`.

### Invite path (comment 0 — closed)

- Canonical invite URL: `POST /api/plans/:planId/invite`
- Handler reads `req.params.planId` only. Do not accept a parallel `tripId` path or body alias.
- **Remove** `POST /api/invites/trips/:tripId/invite` (no compatibility alias). Accept stays `POST /api/invites/invitations/:invitationId/respond`.
- In the same pass, update the Newman/Postman invite request to the new path.
- Do not rename Mongo collections, PlanUser fields, leftover `Trip.js`, or `/api/events` in this pass.

### List plans (shipped `f3526f6`)

`GET /api/plans` returns `{ plans }` for every plan where the caller is `ownerId` or has a PlanUser row. A pending or rejected invitation does not list the plan.

### Invite permissions (shipped `a8b50e4`, stored names `837f60f`)

`POST /api/plans/:planId/invite` runs for Owner or Collaborator. Guest is 403 before the handler.

Body `role` mapping (stored value is the formal name):

- Collaborator, VibePlanner, planner → stored `Collaborator`. Owner only.
- Guest, Wanderer, wanderer → stored `Guest`. Owner or Collaborator.
- Owner, VibeCoordinator, and UI labels (Organizer, Host, Co-Planner, Attendee, Planner) → 400.

Response is `201 { msg, invitation }` with the stored formal role.

Reads still treat leftover Vibe* / short names as the new roles. `backend/scripts/migrate-plan-roles.js` rewrites old strings on `planusers` and `invitations` (run once against Atlas on 28 Sep 2026).

### Invitation inbox (shipped `eecf623`)

`GET /api/invites` returns a raw array of invitations where the caller is the invitee. Newest first. Optional `?status=pending|accepted|rejected` (any other value → 400). Each item includes `_id`, `planId`, `role`, `status`, `invitedBy`, `createdAt`, `planName`, and the inviter’s name and email. Invites the caller only sent are omitted. Missing token → 401. Matches `invitation_provider.dart`.

---

## 2. Naming

| Product word | Meaning | Code today |
|---|---|---|
| Plan | One collaborative occasion | `Plan`, `/api/plans` |
| Plan type trip | Travel; destination required | `type: trip` |
| Plan type event | Conference, wedding, gathering; location required | Stored enum still `plan` until Q10 |
| Activity | One timed row on the itinerary | Flutter `Activity`, `POST/PUT/DELETE /api/activities`, Mongo `activities`. Model file `Event.js`. |
| Itinerary | Activities sorted by `startTime` with day numbers | `GET /api/plans/:id/itinerary` |

Industry wording “the event” means a Plan of type **event**, not an Activity.

**Locked 25 September 2026**

- Plan is the occasion.
- Plan types are `trip` and `event`.
- An itinerary row is an Activity.
- Code model file remains `backend/models/Event.js`. Collection is `activities` (renamed from `events` on Atlas, 1 Oct 2026). Routes are `/api/activities`. `/api/events` was removed (`POST` returns 404). Flutter model is `Activity`.
- Stored plan-type value `plan` means event until migrated.

---

## 3. Roles

`POST /api/plans` sets `ownerId` to the creator and inserts an Owner PlanUser. Reassign is Owner-only; target must already be a Collaborator. Accept invite upserts PlanUser.

### Current code (stored values, `837f60f`)

| Stored role | Where stored | Permissions (current code) |
|---|---|---|
| Owner | `Plan.ownerId` and PlanUser | Creates plan; may invite Collaborator or Guest; can reassign; can remove Collaborator or Guest; may create/update/delete activities |
| Collaborator | PlanUser | May invite Guest; may create/update/delete activities. May not invite another Collaborator. |
| Guest | PlanUser | Can read itinerary and appears on `GET /api/plans` when a PlanUser; cannot invite; cannot create/update/delete activities |

Reads still accept leftover `VibeCoordinator` / `VibePlanner` / `Wanderer` and short `coordinator` / `planner` / `wanderer`. New writes use only Owner / Collaborator / Guest.

### Locked names (26 Sep product/UI; 28 Sep stored)

Formal names and stored names are now the same: **Owner**, **Collaborator**, **Guest**.

UI labels by plan type (Flutter only; not accepted on the invite body):

| Formal / stored | UI on a trip | UI on an event |
|---|---|---|
| Owner | Organizer | Host |
| Collaborator | Co-Planner | Planner |
| Guest | Attendee | Guest |

### Account type vs plan role (comment 9 — closed 28 September 2026)

These are two ladders. Do not mix them.

| Ladder | Field | Values | Question it answers |
|---|---|---|---|
| Plan role | `PlanUser.role` | Owner / Collaborator / Guest | What can this person do **on this plan**? |
| Account type | `User.role` | `member` (default) or `admin` | Is this person a normal member or staff? |

Rules:

- Register creates a **member**. Do not assign a plan role at register.
- Creating a plan makes that member **Owner of that plan** via PlanUser, not an app admin.
- Only `admin` may use support functions that reach **any** user or **any** plan (lookup by email, list their plans, read a plan when investigating, reset/resend password or invite, read support logs).
- Those actions are in the **admin’s own name**. They are not silent impersonation (“act as Mary”). Impersonation is out of scope until there is an audit log and a tiny admin list.
- An admin who participates in a plan still needs a PlanUser row for ordinary member actions on that plan.
- Being Organizer of a trip does not make someone an app admin.

**This pass:** lock the field and the rule. Do not build admin screens. Set `admin` by hand in Mongo for Ken’s account when needed. Comment 8 (admin log viewer) requires `User.role === admin`.

---

## 4. Auth

- `POST /api/auth/register` — firstName, lastName, email, password. Model hashes password once.
- `POST /api/auth/login` — `{ token, user }`. JWT claim `userId` (`id` accepted as alias).
- Forgot / reset password; verify-token; logout; profile patch.
- Logout writes the raw bearer token to Redis for 24 hours when Redis is up. `authMiddleware` returns `401 { message: Token has been revoked }` when Redis GET is blacklisted. If Redis is down, the check is skipped (degraded).

Redis is operations + security for revocation, not the system of record. Mongo holds users, plans, activities, invitations. Alpha should run Redis (Memurai on Windows). Jest and Newman do not require Redis.

Environment variables for auth and Redis are defined in [section 12](#12-app-configuration-env).

---

## 5. Activities and itinerary

- `POST /api/activities`: name, type, planId, startTime, endTime. `ownerId` from the token. `/api/events` is no longer mounted (404).
- `PUT /api/activities/:id` and `DELETE /api/activities/:id` exist. There is no PATCH route. Flutter Owner/Collaborator can add, edit, and delete. Guest can read the itinerary (`GET /api/plans/:planId/itinerary`) and does not see those controls.
- Optional `originTimeZone` and `destinationTimeZone` (flights).
- GET itinerary: sort by `startTime`; first activity is day 1; flights use `destinationTimeZone` when set, else `plan.timeZone`; Luxon DST when the zone is IANA.
- Create / update / delete require Owner or Collaborator on that plan (`655c2f4`). A missing PlanUser row still counts as Owner when `Plan.ownerId` is the caller. Guest or non-member → 403, no write. Guests may still read the itinerary.

Product types include flight, car, dining, hotel, tour, attraction, cruise, plus Flutter extras (train, ceremony, reception, custom, …). Backend stores type as a string and does not enum-enforce.

### Activity history and restore (comment 2 — shipped `b8ed090` + `0b80b87`)

Design **B**: version history per activity, then restore a previous version. Not a single global Undo button. Not invite/role history. Not the admin log (comment 8).

**Who**

- Owner, Collaborator, and Guest may `GET /api/events/:id/history` (leftover Wanderer alias and ownerId-with-no-PlanUser count). Non-member → 403. No token → 401. Unknown id with no revisions → 404.
- Owner and Collaborator may `POST /api/events/:id/restore`. A Collaborator may restore an activity the Owner last edited. Guest or non-member → 403. No token → 401.

**What is recorded**

Model `ActivityRevision` collection `activityrevisions`: `_id`, `eventId`, `planId`, `userId`, `action` (`create` | `update` | `delete`), `snapshot`, `createdAt`, top-level `deleted`. Index `{ eventId: 1, createdAt: -1 }`.

Revision is inserted only after the activity write succeeds. `snapshot` is the saved document (type change already ran `activityTypeFields.js`). On delete, snapshot is the activity just before removal and `deleted` is true. If the revision insert throws, log and still return the activity success. Guest PUT/DELETE stays 403 and does not add a revision. History still works after delete.

**Restore (shipped `0b80b87`)**

`POST /api/events/:id/restore` body `{ revisionId }` only. Extra activity fields in the body are ignored. Snapshot is applied through `activityTypeFields.js` with `newType = snapshot.type`. Activity keeps `_id` and `planId`. Existing row is updated in place; deleted row is inserted again with the same `_id`. Both append an `ActivityRevision` with `action: update` and `deleted: false`. Missing revision → 404. Revision whose `eventId` or `planId` does not match → 400, no write. Flight or train snapshot without both time zones → 400. No email.

### Change activity type (comment 3 — shipped `04dd649`)

Owner or Collaborator may change `type` on `PUT /api/events/:id`. Shared fields stay; type-specific fields that do not apply to the new type are cleared **on the server**. No email on type change. Guest still 403. No PATCH.

Logic lives in `backend/utils/activityTypeFields.js`. The PUT handler calls it after the membership check and does not contain the field lists.

**Shared fields (keep unless the body replaces them):** name, startTime, endTime, location, details, cost, costType, status, serviceProvider, bookingReference, urlLinks, planId, ownerId, eventNum, extras.

**Type-specific**

| Fields | Belong to |
|---|---|
| `originTimeZone`, `destinationTimeZone` | `flight`, `train` |
| `gate`, `baggageClaim` | `flight` |
| `roomNumber` | `hotel`, `ceremony`, `reception` |
| `customType` | `custom` |

If type does not change, omitted type-specific fields are kept. A client that still sends `gate` on a hotel does not keep it. Flight or train PUT still requires both time zones.

### Breakouts and rooms

- Same Plan, same flat itinerary.
- An Activity may include `room` (label) and optional `parentActivityId`.
- Parallel breakouts: overlapping `startTime`, different `room`.
- Client groups by room or parent. No nested `subEvents` array. No child Plan per room.

`room` and `parentActivityId` are the intended shape (Q11); not on the live schema yet. Breakouts on the same day are handled in the UI (comment 4 — decided).

---

## 6. Notifications and email

- Email only via `EMAIL_PROVIDER`: `resend` | `sendgrid` | `console`. Default when empty: `resend`.
- `EMAIL_FROM` optional. Empty (see [section 12](#12-app-configuration-env)) falls back to `ken@eratespecialists.com`.
- Plan created, invite, accept/reject, remove, reassign notify. Activity create does not notify.
- Forgot-password uses `sendEmail` to the account email only (no Ken override). Failure returns 500.
- Push is still future. SMS is comment 7 (locked below; not shipped until the CLI pass).

### `notifyUsers` To address (comment 6 — closed)

Work top to bottom. Stop at the first match.

1. If `.env` has a non-empty `NOTIFY_OVERRIDE_EMAIL` → everyone’s mail goes to that one address. That is how you keep alpha from emailing real guests.
2. Else if `NODE_ENV=development` → To is `w.ken.allen@gmail.com`.
3. Else → To is that user’s email.

Then skip the send if:

- the user has no email, or
- they turned email off (`notificationPreferences.email === false`).

`EMAIL_FROM` is only the sender. Forgot-password does not use this chain.

### SMS (comment 7 — shipped `e80d420`)

SMS is a second channel on the same `notifyUsers` events as email (plan created, invite, accept/reject, remove, reassign). Activity create / type change / restore still do not notify. Forgot-password stays email only.

Send logic is in `backend/utils/sms.js`. `notifyUsers` calls `sendSms({ to, body })` after email. Textbelt can be replaced later by adding a branch in this module only. `notifyUsers` must not contain Textbelt URLs or keys. The module exports `sendSms({ to, body })` and switches on `SMS_PROVIDER`.

**Providers**

- `console` — log the text, do not send. Jest always mocks or uses console.
- `textbelt` — POST `https://textbelt.com/text` with `TEXTBELT_KEY`. Never log the key.
- Empty `SMS_PROVIDER` → `console` (do not send, do not crash).
- A later provider (Telnyx, etc.) is a new branch in this module only.

**Who is texted (To), top to bottom**

1. If `NOTIFY_OVERRIDE_SMS` is not empty → every SMS goes to that number. This is how development avoids texting real guests.
2. Else if `NODE_ENV=development` → do **not** text the user’s stored phone. Log and skip (so a missing override cannot bill your 200-text quota against guests).
3. Else → that user’s `phoneNumber`.

Then skip if:

- `notificationPreferences.sms !== true`, or
- after the chain above there is no number.

Numbers should be E.164 when sending (`+1…`). If the stored value has no `+`, the module may prefix `+1` for 10-digit US numbers; do not guess other countries.

Email and SMS fail independently. An SMS failure is logged (provider name, status, message — not the key) and must not fail the HTTP handler.

---

## 7. Logging for support

- Structured logs: timestamp, level, event, `userId` when known, resource ids.
- Never log passwords, raw JWTs, API keys, or Authorization headers.
- Register/login: email and `userId` only.
- Mail failure: provider name, message, HTTP status — not the key.

### Admin support log (comment 8 — slice 1 `1067791`, slice 2 not shipped, slice 3 `4d98550`)

Two destinations:

- **Console:** process issues (startup failures, uncaught errors, stack traces, “Redis down”). Not queried by the admin UI.
- **Mongo `supportlogs`:** product/support events the admin UI will filter and sort (register/login without secrets, mail/SMS failure without keys, invite, accept/reject, activity write/restore). Append-only.

Requires `User.role === admin` (account type, not a plan role). Register still creates `member`. Set Ken to `admin` by hand in Atlas.

**Slice 1 (shipped `1067791`):** `User.role` is `member` | `admin` (register always `member`, body `role` ignored). `requireAdmin` loads role from the DB. `logSupport` writes `supportlogs` and must not fail the request. `GET /api/admin/logs` returns `{ logs }`. Filters: `event`, `level`, `userId` (actor), `planId`, `from`, `to`. Sort `createdAt` desc default; `limit` default 50 max 100. Member → 403, no token → 401. Only hooked write this slice: `POST /api/plans` → `PlanCreated`. Secrets stripped from `extra`.

**Atlas note:** leftover `User.role` values `Vibe*` will fail validation on the next save of that user. Run an update to `member` (except Ken → `admin`) before relying on profile PATCH.

**Slice 2 (shipped `17d341c`):** one `supportlogs` row per completed `/api` request via `backend/middleware/requestLog.js` on `res.finish`. `event` is `METHOD` + route pattern when known. `level` info/warn/error by status. Skip `OPTIONS` and `GET /api/admin/logs`. Optional `SUPPORT_LOG_SKIP`. `extra` is only method, path, statusCode. Named events `PlanCreated` and `UserDeleted` remain (two rows on those calls is OK).

**Slice 3 (shipped `4d98550`):** static `admin-web/`.

No impersonation. No reading a `.log` file from Flutter.

### Admin user picker (shipped `f2b8862`; search-delay setting not shipped)

`GET /api/admin/users?q=` — `requireAdmin`. `q` is a case-insensitive substring of **email** only. Minimum 2 characters after trim; shorter or missing → `400` or empty `{ users: [] }` (pick empty list). Limit 20, sort email asc.

Each item: `_id`, `email`, `firstName`, `lastName`, `role`. Never password, resetToken, or hashes.

Admin-web: Account Filter matches as the admin types. Choosing a row sets the log filter user id only. It does not arm Delete user. Do not send `q` to any non-admin route.

### Admin explorer (2 Oct 2026)

Drill-down is a stack of dialogs. Close returns to the caller. Account Filter does not arm delete.

- User dialog: email, first name, last name, phone, account role, and plans where that user has a stored role. Plan rows show plan name, type, dates, and role, not the plan id. `GET /api/admin/users/:userId`. Delete user is on this dialog and uses `DELETE /api/admin/users/:userId` (409 if a shared owned plan remains).
- Plan dialog: opened from a plan row. Fields, members with stored role, activities by name, type, and start time. `GET /api/admin/plans/:planId`. Delete plan is on this dialog: `DELETE /api/admin/plans/:planId`. 409 if another member or a pending invitation remains. Sole plan removes its activities, revisions, invitations, and support logs, then the plan.
- Activity dialog shipped 2 Oct 2026: opened from an activity row. Shows name, type, start, end, location, details, and revisions newest first. Each revision shows action, time, and the account email. A deleted account leaves the email blank. `GET /api/admin/activities/:activityId`. Delete activity is on this dialog: `DELETE /api/admin/activities/:activityId`, writes the same delete revision as the member path. Edit form is not shipped.
- Support log table shows Account Email (`actorEmail`) and Plan (`planName`). Ids stay on the row for filters and tooltips, not as cell text. Login and logout rows persist `actorEmail`. Event menu seeds `/api/activities`. Old `/api/events` rows remain selectable.
- Local runner: `node serve.js` in `admin-web` on port 5500. `r` or `R` reloads open admin tabs. `npx serve` remains a fallback.

---

## 8. Tests

- `npx jest` in backend — in-memory Mongo, `notifyUsers` mocked.
- `npm run test:postman` — Newman against a running server at `http://localhost:3000`. Redis not required for that command.

---

## 9. Data model (live MongoDB)

As of 25 September 2026. Collection names are Mongoose defaults.

### User (`users`)

Fields include firstName, lastName, email (optional on schema, required by register), phone, address, notificationPreferences (email default true, sms default false), **`role` account type `member` | `admin` (default `member`; comment 9)**, password (bcrypt 12, required), resetToken / expiry, createdAt. Unique index on email. Do not log the password hash. Plan permissions do not read this field.

### Plan (`plans`)

type enum `trip` | `plan`, name, destination required when trip, location required when plan, dates, autoCalculate flags, budget, planningState `initial` | `reviewing` | `complete`, timeZone, ownerId required, embedded `participants[]`, `activityIds[]`. Indexes: text name+destination; ownerId. Membership used by invites is PlanUser, not `participants`.

### PlanUser (`planusers`)

planId, userId, role `Owner` | `Collaborator` | `Guest`. Unique compound planId+userId. Reads still normalize leftover Vibe* / short names.

### Invitation (`invitations`)

planId, userId, invitedBy, role `Collaborator` | `Guest`, status pending | accepted | rejected. Index planId+userId+status, not unique. No `ref()` on the three id strings.

### Event / Activity (`activities`)

Mongo collection `activities` (renamed from `events` on 1 Oct 2026). Mongoose model file remains `backend/models/Event.js`. Flutter model is `Activity` (`activity.dart`). Routes are `/api/activities`. `/api/events` returns 404. History and restore are `/api/activities/:id/history` and `/api/activities/:id/restore`. Itinerary list remains `GET /api/plans/:planId/itinerary`.

name, type string, planId, ownerId, times, time zones, cost/costType, location, details, customType, eventNum, status draft | complete, serviceProvider, bookingReference, urlLinks, extras, gate, baggageClaim, roomNumber. `subEvents` is written as `[this]`, not nested Event documents. No extra indexes besides `_id`.

Present but not the live path: `Trip.js`, `TripUser.js` (index on `tripId` while field is `planId`), Plan discriminator inside `Event.js`.

### Referential integrity (locked 30 Sep 2026)

MongoDB does not enforce foreign keys. Integrity is an **application and cleanup** rule, not a database constraint. Do not add Mongoose `ref()` as a substitute for this (Q9 stays “ids are strings”).

**Parent → children (delete children first)**

| Parent | Children that must not outlive it |
|---|---|
| `users._id` | `planusers.userId`; `invitations.userId` and `invitedBy`; `plans.ownerId` (see product rule); `events.ownerId`; `activityrevisions.userId`; `supportlogs.actorUserId` |
| `plans._id` | `planusers.planId`; `invitations.planId`; `events.planId`; `activityrevisions.planId`; `supportlogs.planId` |
| `events._id` | `activityrevisions.eventId`; `supportlogs.eventId` |

**Product rule for a real account:** do not cascade-delete a user’s plans from Newman cleanup or a casual script. Test cleanup may delete plans owned by matching test emails only.

### Admin delete user (locked 30 Sep 2026; shipped `d86b6f1`)

`DELETE /api/admin/users/:userId` — `requireAdmin` only. Acts in the admin’s name. No impersonation.

**Plan rule:** do **not** delete a plan if any other user still references it (a `planusers` row for a different `userId`, or a pending invitation to someone else).

Walk, in order:

1. **409** if the target **owns** a plan that has another PlanUser or a pending invite to another user. Response lists those plan ids and names. Admin must reassign Owner first (existing reassign). This pass does not auto-promote a Collaborator.
2. **409** if `:userId` is the caller (no self-delete).
3. Delete invitations where this user is invitee or inviter.
4. Delete this user’s `planusers` rows.
5. For plans with `ownerId === target` that have no other PlanUser and no pending invite to anyone else: delete `events`, `activityrevisions`, remaining invitations, `supportlogs` for that planId, then the plan.
6. Leave `supportlogs` that only name the user as actor on plans that still exist (audit).
7. Delete the `users` document.
8. Activities on surviving plans stay, even if `events.ownerId` was the deleted user.

**404** if the user does not exist. **403** if the caller is not admin. Id only — no email glob on this route.

**Orphan** = a child id that is not in the parent collection (plan with `ownerId` not in `users`; invite with missing user or plan; `planusers` with missing user or plan).

**Test cleanup order:** preview with `find` → delete `planusers` / `invitations` / `events` / `activityrevisions` / `supportlogs` for those ids → delete `plans` if they are test-owned → delete `users`. Never match delete by first name.

**API writes** already insert the pair on purpose (create plan → `plans` + Owner `planusers`; accept invite → `planusers`). They do not currently re-check that `ownerId` still exists on every GET. That check is optional later, not this pass.

---

## 10. Open model questions

- Q1. User.email optional on schema vs required on register.
- Q2. User.role vs PlanUser.role. **Closed (comment 9):** PlanUser is plan membership; User.role is account type `member` | `admin`. See section 3.
- Q3. Plan.participants vs PlanUser as source of truth.
- Q4. Event.subEvents is `[this]`, not nested documents.
- Q5. Unused Trip, TripUser, Event.js Plan discriminator.
- Q6. TripUser index tripId vs field planId.
- Q7. participants.userId ObjectId vs User._id string.
- Q8. Event.type unconstrained vs product type list.
- Q9. Invitation missing `ref()` on ids. **Closed as policy:** string ids stay; integrity is the table in section 9, not Mongoose `ref()`.
- Q10. Plan.type `plan` → `event` is still open. Event → Activity route and collection are done: `/api/activities`, Mongo `activities`, Flutter `Activity`. Model file is still `Event.js`.
- Q11. Add `parentActivityId` and `room` on Event/API; grouping is a client concern.

---

## 11. Known gaps (not implemented)

- ~~Planner inviting a wanderer~~ **Done 28 Sep 2026 (`a8b50e4` + `837f60f`):** Collaborator may invite Guest; only Owner invites Collaborator. Body aliases accepted; stored role is Owner / Collaborator / Guest.
- ~~Plan-role checks on activity create/update~~ **Done 28 Sep 2026 (`655c2f4`):** POST/PUT/DELETE `/api/events` require Owner or Collaborator. Guest and non-member are 403. No PATCH. Guests can still GET itinerary.
- ~~GET that lists the caller’s invitations~~ **Done 28 Sep 2026 (`eecf623`):** `GET /api/invites` raw array for the invitee. Optional status filter. Includes planName and inviter details.
- Socket.IO server; SQLite cache.
- Flutter day numbers still device-local.
- Plan.type stored value `plan` is not yet migrated to `event`.
- ~~`GET /api/plans` owner-only~~ **Done 28 Sep 2026 (`f3526f6`):** returns `{ plans }` the caller owns or has a PlanUser row for. Pending/rejected invites do not count.

---

## 12. App configuration (.env)

This section is the glossary for settings that live outside the database. It answers which names are `.env` variables and what “empty” means.

### Where settings live

The Node backend reads configuration from environment variables when the process starts. On the laptop those variables are written in the backend `.env` file (same folder as `package.json`, or the backend folder in the monorepo). That file is not committed to Git because it can hold secrets (database URI, JWT secret, mail API keys). A `.env.example` file may list the names with fake values so another machine knows what to set.

MongoDB holds users, plans, activities, and invitations. Redis holds the optional logout blacklist and refresh tokens. Neither stores `EMAIL_FROM` or `JWT_SECRET`.

### What “empty” means in this document

Unless a row in the table below says otherwise, a variable is **empty** when any of these is true:

- The name is missing from `.env` (and not set in the shell).
- The name is present but the value is blank, for example `EMAIL_FROM=`
- The value is only spaces.

Empty is not a crash by itself. Each variable has a fallback or a hard requirement, listed in the table. Do not write the word `empty` in `.env` as a value.

### How to read a `.env` line

A line looks like `NAME=value` with no spaces around the equals sign. Text after `#` is a comment. Values with spaces should be quoted. Example:

```bash
EMAIL_FROM=PlanItVibe <noreply@mail.eratespecialists.com>
NODE_ENV=development
# this line is ignored
```

### Variable list

Do not put real secrets in this file.

| Variable | What it is | Empty means | Fallback or rule |
|---|---|---|---|
| `PORT` | HTTP port the API listens on. | Missing or blank. | Use `3000`. |
| `MONGODB_URI` | Connection string for MongoDB (local or Atlas). | Missing or blank. | Required to start. Do not guess a URI. |
| `JWT_SECRET` | Secret used to sign login tokens. | Missing or blank. | Required in any real environment. Never log it. |
| `JWT_ACCESS_EXPIRES_IN` | How long an access token lasts. | Missing, blank, or not a number plus `s`, `m`, `h`, or `d`. | Use `15m`. |
| `JWT_REFRESH_EXPIRES_IN` | How long a refresh token lasts. | Missing, blank, or not a number plus `s`, `m`, `h`, or `d`. | Use `30d`. |
| `NODE_ENV` | Runtime mode. `development` vs production (or similar). | Missing or blank. | Treat as not-development. The Ken Gmail override in `notifyUsers` only applies when this is exactly `development`. |
| `REDIS_URL` | Where Redis/Memurai lives. It stores the logout token blacklist and refresh tokens. | Missing or blank. | Try `localhost:6379`. If Redis is down, logout blacklist is skipped and a refresh later fails (degraded). Mongo remains the system of record. |
| `EMAIL_PROVIDER` | Which mail sender to use: `resend`, `sendgrid`, or `console`. | Missing or blank. | Use `resend`. `console` logs mail instead of sending. Forgot-password is still raw SendGrid in `auth.js` until that path is switched. |
| `EMAIL_FROM` | From address on mail the app sends. This is not the recipient. | Missing, blank, or only spaces. | Use `ken@eratespecialists.com`. Alpha/production should set this to an address on the verified domain `mail.eratespecialists.com` (not `onboarding@resend.dev`). |
| `NOTIFY_OVERRIDE_EMAIL` | Force every `notifyUsers` recipient to one inbox (To address). | Missing, blank, or only spaces. | Do not override. Next rule: if `NODE_ENV=development`, To is `w.ken.allen@gmail.com`; otherwise To is each user’s email. Skips users with no email or `notificationPreferences.email === false`. Forgot-password does not use this override. |
| `RESEND_API_KEY` | Resend vendor key. | Missing or blank. | Required when `EMAIL_PROVIDER` is `resend`. Never log it. |
| `SENDGRID_API_KEY` | SendGrid vendor key. | Missing or blank. | Required when `EMAIL_PROVIDER` is `sendgrid`, and today for forgot-password. Never log it. |
| `SMS_PROVIDER` | Which SMS sender: `console` or `textbelt` (later vendors add a value here). | Missing or blank. | Use `console` (log only, do not send). |
| `TEXTBELT_KEY` | Textbelt quota key. | Missing or blank. | Required when `SMS_PROVIDER` is `textbelt`. Never log it. Do not commit it. The public word `textbelt` is the 1/day free key; your paid quota uses the key Textbelt gave you. |
| `NOTIFY_OVERRIDE_SMS` | Force every `notifyUsers` SMS to one number. | Missing, blank, or only spaces. | Do not override. In `NODE_ENV=development`, do not fall through to the user’s phone — skip live SMS. In production, To is the user’s `phoneNumber` if SMS pref is on. |

### From vs To (do not mix these)

`EMAIL_FROM` is only the sender shown on the message. Who receives `notifyUsers` mail is the comment 6 chain in section 6.

Forgot-password mail always goes to the account email. It does not use `NOTIFY_OVERRIDE_EMAIL` or the development Gmail override.

### Recommended laptop `.env` for alpha

Use real secrets from your password manager. The From address should be on the verified Resend domain.

```bash
NODE_ENV=development
PORT=3000
MONGODB_URI=<your Atlas or local URI>
JWT_SECRET=<long random string>
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=30d
REDIS_URL=redis://127.0.0.1:6379
EMAIL_PROVIDER=resend
EMAIL_FROM=PlanItVibe <noreply@mail.eratespecialists.com>
NOTIFY_OVERRIDE_EMAIL=w.ken.allen@gmail.com
RESEND_API_KEY=<resend key>
SENDGRID_API_KEY=<still needed for forgot-password until that path is switched>
SMS_PROVIDER=console
# To send live test texts (uses your paid Textbelt quota):
# SMS_PROVIDER=textbelt
# TEXTBELT_KEY=<your Textbelt key>
# NOTIFY_OVERRIDE_SMS=+1XXXXXXXXXX
```

If you already created a different mailbox on `mail.eratespecialists.com`, put that address in `EMAIL_FROM` instead of `noreply@…`.

### Comment 5 — closed

`EMAIL_FROM` is a `.env` variable. “Empty” means missing, blank, or only spaces. In that case the From address is `ken@eratespecialists.com`. Set `EMAIL_FROM` for alpha so the fallback is rarely used.

### Comment 6 — closed

`notifyUsers` To-address rule is the top-to-bottom chain in section 6. No code change; this pass is wording only.

### Comment 0 — closed

Invite URL is `POST /api/plans/:planId/invite` only. Retired path is `POST /api/invites/trips/:tripId/invite`. No alias. Update Newman in the same CLI pass. Accept URL unchanged.

---

## Open items (Word comments)

Comments remain in `PlanItVibe-requirements.docx` until closed. Do not implement a comment until its rule is locked here.

| # | Status | Topic | Note |
|---|---|---|---|
| 0 | Closed | Leftover `/trips/` path | `POST /api/plans/:planId/invite` only. No alias. Update Newman same pass. |
| 1 | Closed | Role names and UI by plan type | Formal + stored Owner/Collaborator/Guest (`837f60f`). Flutter UI labels later. |
| 2 | Closed | Activity history + restore | `b8ed090` history; `0b80b87` restore. Guest reads history only. |
| 3 | Closed | Change activity type, keep fields | `04dd649` `activityTypeFields.js`. roomNumber also kept for ceremony/reception. |
| 4 | Decided | Same-day breakouts | UI grouping. Schema fields still Q11. |
| 5 | Closed | `EMAIL_FROM` / “empty” | Section 12. |
| 6 | Closed | `notifyUsers` To-address chain | Section 6. Wording only; no CLI pass. |
| 7 | Closed | SMS via Textbelt module | `e80d420` `backend/utils/sms.js`. Console default; Textbelt live; `NOTIFY_OVERRIDE_SMS`. |
| 8 | Slice 2 shipped `17d341c` | Admin log viewer | Per-request middleware. Skip GET logs and OPTIONS. UI is admin-web. |
| 9 | Closed | What are the roles? (`User.role`) | Section 3: plan roles vs `member`/`admin`. No admin UI this pass. |
| 10 | Route and collection done | Event → Activity | `/api/activities`, Mongo `activities`, Flutter `Activity`. `/api/events` removed. Model file still `Event.js`. Plan.type `plan` → `event` still open. |

---

## Shipped since 30 Sep 2026

Not a full commit list. Product rules that landed after the 30 Sep spec sync:

- Flutter web runs against `http://localhost:3000`. Development CORS allows `http://localhost` and `http://127.0.0.1` on any port. Production CORS stays the admin origins only (`f21d33e`).
- Flutter login stores the JWT. Home list and create use `/api/plans`. A 401 returns to login.
- Invite inbox uses `GET /api/invites` (raw array) and `POST /api/invites/invitations/:id/respond` with `{ status: accepted|rejected }`.
- Role labels: trip Organizer / Co-Planner / Attendee; stored type `plan` Host / Planner / Guest. API still stores Owner / Collaborator / Guest. A pending invite without plan type uses the trip labels.
- Plan detail loads `GET /api/plans/:planId/itinerary`. Owner or Collaborator can add, edit, and delete. Guest can read and does not see those controls.
- Activity writes are `/api/activities`. `/api/events` is removed (404). Newman requests 11, 12, and 17 post `/api/activities`.
- Mongo collection is `activities` (renamed from `events` on Atlas, 1 Oct 2026). Model file remains `backend/models/Event.js`. Flutter model is `Activity`.
- One-time rename script was run and then removed. Do not recreate `events`.

---

## Refine process

One item at a time: lock a short rule in this file → Grok Build CLI on the laptop changes only that code → `npx jest` (then Newman if it is an HTTP path) → commit → next item.

Suggested next: migrate Plan.type `plan` → `event`, or Flutter day numbers in the plan time zone.
