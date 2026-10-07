# KTVSky capability discovery — 2026-10-08

## Evidence and safety

browser-skill, Edge 154, existing logged-in profile; target https://mlkcms.ktvsky.com/#/login redirected to #/index. No password entry was needed. Fresh credential login was not executed; login request/response and expiry/refresh behavior remain unverified. No raw token, Cookie, password, phone, real MAC, IP or device mapping is recorded here. Browser exports stay outside Git. Record dfb358e2a4902 has 61 requests and no dropped entries; n29 is the actual room query. Earlier read record d333705fdf676 also showed all nine devices offline; later dfb358e2a4902 showed one online and eight offline. These are point-in-time observations, not a guarantee of availability.

No real close, open or timer mutation was executed. No safe test room was supplied. KTVSky MUTATING API DISCOVERY = BLOCKED BY SAFE TEST TARGET. Overall capability discovery is PARTIAL.

## Actually observed read API

GET https://lknewcms.ktvsky.com/h5/search?telno=<redacted>, HTTP 200 (dfb358e2a4902:n29), OPTIONS preflight 200 (n30). Request uses X-TOKEN header, Accept application/json. Response includes Set-Cookie; Cookie significance and token lifetime are unverified. Values were not extracted. Public app bundle configures baseURL https://lknewcms.ktvsky.com with a 10-second client timeout and X-TOKEN interceptor.

Observed response shape:

    { code: number, msg: string, result: {
        store_id: number, store_name: string, caption: string, total: number,
        list: [{ ip: string, room_name: string, mac: string, version: string,
                 alive: number, status: number, opentime: number }]
    }}

Observed code=200,total=9. Frontend index bundle uses alive===1 for ONLINE and otherwise OFFLINE; status is coerced to boolean for the open/close switch. opentime semantics are only partly known. Display room_name is not an internal mapping key; a future adapter must use a verified stable external device identifier (source payload uses mac) and explicit store scope.

## Public frontend contracts, not live mutation evidence

Sources actually read in the browser: /js/app.fa8df8f0.js (n5), /js/main/index.280f0df3.js (n23; also prior record public source), /js/login.fe1b238f.js (navigation n44). Static analysis only:

| Capability | Method/path | Body | Verification |
|---|---|---|---|
| Login | POST /h5/login | {telno,password} | Public form and API wrapper; no fresh login request captured |
| Query room list/state | GET /h5/search | query {telno} | Live observed 200 and response shape above |
| Close | POST /h5/mac_control | {mac,status:0,telno} | Static only, not executed |
| Open with countdown | POST /h5/mac_control | {mac,status:1,opentime:60*minutes,telno} | Static only, not executed |
| Independent countdown update | Unconfirmed | Unconfirmed | No separate timer endpoint identified |

The public UI validates open duration from 1 through 1440 minutes, converts it to seconds, then submits open and timer together. A separate openRoom -> setCountdown implementation must not blindly call this endpoint twice: provider combined-operation semantics and safe update/recovery need acceptance in Stage 4B. Mutation response shape, side-effect completion, auth failure codes, timeout recovery and provider idempotency remain unverified. No requestId/operationId/taskId occurs in these observed static mutation bodies; no exactly-once guarantee is assumed.

The provider public login code offers a remember option using its own local loginInfo storage. This project does not read that storage or reuse it as a credential store. Future credentials must enter a server-side secret boundary. Browser DOM/CSS automation does not enter domain/application code.

## Stage 4B gates

Require an explicitly authorized safe device; verify close/open/combined timer semantics, authoritative state and late-response recovery, stable mapping and store scope, provider identity/idempotency capability, server credential lifecycle and timeout behavior before enabling a real adapter. Device gateway remains productionEnabled=false. Formal employee open is not wired to it.
