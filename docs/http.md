# HTTP and streaming actions

This page covers `apiAction` and `transportAction`, for developers who connect actions to an HTTP API or to a streaming command channel.

## Configuring the HTTP layer

`configureApi` sets up the HTTP layer every `apiAction` uses. Call it once at startup. A later call replaces the whole configuration instead of merging into it. Without it, `apiAction` uses the global `fetch` with the paths as written.

```typescript
import { configureApi } from "@cplieger/actions";

configureApi({
  baseUrl: "https://api.example.com/v1",
  credentials: "include",
  prepareHeaders: (headers, { spec }) => {
    headers.set("Authorization", `Bearer ${getToken()}`);
    headers.set("X-CSRF-Token", getCsrfToken());
  },
});
```

The options follow [RTK Query's `fetchBaseQuery`](https://redux.js.org/toolkit/rtk-query/api/fetchBaseQuery):

- `baseUrl` goes before every `RequestSpec.path`.
- `prepareHeaders(headers, { spec })` sets headers for each request. It may be async, and a `Headers` object it returns replaces the one it received.
- `credentials` is the `RequestInit.credentials` mode, for example `"include"` to send cookies.
- `fetchFn` replaces `fetch`, for server-side rendering or tests.

Each request has a 30-second limit, `API_TIMEOUT_MS` from `@cplieger/fetch`.

## Request paths

Write `RequestSpec.path` as a relative path.

- With `baseUrl` set, the configured scheme and host always come first. An absolute path such as `https://...` or a protocol-relative path such as `//host` stays a path segment and cannot change the origin.
- With `baseUrl` unset, `path` goes to `fetch()` unchanged. The caller owns the full URL, so never pass untrusted input, such as a string from the server, as the whole path.

## Request bodies and headers

`body` is sent as JSON with `Content-Type: application/json`. `headers` on a request adds headers for that request only:

```typescript
const createItem = apiAction({
  name: "items.create",
  request: (item) => ({
    method: "POST",
    path: "/items",
    body: item,
    headers: { "X-Request-Id": crypto.randomUUID() },
  }),
});
```

For a body that is not JSON, `rawBody` takes a pre-encoded `BodyInit` and sends it as it is, with no JSON encoding and no automatic `Content-Type`. Set the type in `headers`:

```typescript
const saveConfig = apiAction<string, unknown>({
  name: "config.save",
  request: (yaml) => ({
    method: "PUT",
    path: "/api/config",
    rawBody: yaml,
    headers: { "Content-Type": "text/yaml" },
  }),
});
```

`body` and `rawBody` are mutually exclusive. A `GET` request carries neither.

## Decoding responses

By default, any 2xx response is a success and its parsed body is the result, and any failure becomes an `ActionError`. Two optional hooks change that for servers with their own envelopes.

`decode(data, { status, spec })` runs on every 2xx response and returns the result. A throw sends the dispatch to the error branch, with rollback, the error notification and an error entry in the action log. Use it for a server that answers HTTP 200 for failures too:

```typescript
const stage = apiAction<{ repo: string }, { output?: string }>({
  name: "git.stage",
  request: (args) => ({ method: "POST", path: "/api/git/stage", body: args }),
  // The server replies HTTP 200 for both outcomes, and a non-empty
  // `error` field is the failure signal.
  decode: (data) => {
    if (hasErrorString(data) && data.error !== "") {
      throw new ActionError(data.error, { code: "git" });
    }
    return data as { output?: string };
  },
});
```

`decodeError(info, { spec })` runs on every failure that produced a real HTTP response. `info` carries `status`, `message`, `code`, the parsed JSON `body` and `headers`, the last three when present. The hook returns one of three values:

- `{ kind: "success", value }` resolves the dispatch as a success, for example a 409 whose body is a meaningful payload.
- `{ kind: "error", error }` replaces the default error.
- `undefined` keeps the default error.

```typescript
const deleteTool = apiAction<{ name: string }, DeleteToolResult>({
  name: "tools.delete",
  request: ({ name }) => ({ method: "DELETE", path: `/api/tools/${name}` }),
  error: false, // a 409 is a normal flow here, handled by the caller
  decodeError: (info) =>
    info.status === 409
      ? { kind: "success", value: (info.body ?? {}) as DeleteToolResult }
      : undefined,
});
```

A network failure, a timeout or a cancellation has status 0 and never reaches `decodeError`, so the hook cannot change how `retryNetwork` classifies a failure or how cancellation behaves. `info.body` comes from the server, so check its shape before you read a field.

A wire format beyond these hooks still fits a plain `defineAction`, whose `run()` can do anything.

## Streaming commands

`transportAction` sends a command through a channel you supply, such as a command endpoint whose replies arrive later over server-sent events. Connect the channel once with `configureTransport`:

```typescript
configureTransport(async (cmd, { signal }) => {
  const res = await fetch("/api/commands", { method: "POST", body: JSON.stringify(cmd), signal });
  return { ok: res.ok, status: res.status };
});

const stop = transportAction({
  name: "session.stop",
  command: (id: string) => ({ type: "stop", id }),
});
```

- `cmd` always has a `type` field, and `command(args)` builds it for each dispatch.
- The send function returns `{ ok, status, error?, code? }`. `ok: false` sends the dispatch to the error branch.
- The action's result is `void`, because any reply arrives later through your own channel.
- `configureTransport` is needed only when you use `transportAction`. Without it, a `transportAction` dispatch fails with the code `transport_not_configured`.
