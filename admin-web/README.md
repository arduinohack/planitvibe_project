# PlanItVibe admin

Static page for the existing API. Open it from a local static server. A `file://` page cannot call the API.

From `backend`:

```
node server.js
```

From `admin-web`:

```
node serve.js
```

That serves this folder on port 5500. In that terminal, `r` or `R` tells every open admin tab to reload. `q` quits. It does not watch the filesystem. The reload listener is added only to `index.html` responses.

`npx --yes serve -l 5500` still works as a fallback. That fallback does not reload tabs from a key.

Then open http://localhost:5500. The API allows that origin, `http://127.0.0.1:5500`, and `http://localhost:8080`.

Settings (`#settings`) saves the display time zone in `localStorage` as `planitvibe.admin.timeZone`. An empty value uses the browser time zone. Support-log times are shown in that zone. It also saves `planitvibe.admin.searchDelaySec` for the user-picker wait. A missing or out-of-range value uses 2 seconds. Text styles are saved as `planitvibe.admin.styles`. It does not call the API.

After login, the top banner shows the admin name and email. That display is kept in `sessionStorage` with the token so a refresh can restore it. A token without that record shows no name.

Logs and Delete share an email picker. After two characters it calls `GET /api/admin/users?q=` and a chosen row supplies the user id for the log filter and for delete. Delete still uses that id. There is no delete-by-email.
