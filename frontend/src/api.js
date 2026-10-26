export async function api(
  url,
  { method = "GET", body } = {}
) {
  const response = await fetch(`/api${url}`, {
    method,
    credentials: "same-origin",
    headers:
      body === undefined
        ? {}
        : {
            "Content-Type": "application/json",
          },
    body:
      body === undefined
        ? undefined
        : JSON.stringify(body),
  });

  const json = await response
    .json()
    .catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      json.error ||
        `Request failed (${response.status})`
    );
  }

  return json;
}