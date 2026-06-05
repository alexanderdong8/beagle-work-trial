export async function apiGet(path) {
  // Small fetch wrapper keeps page components focused on workflow state rather
  // than repeated response/error boilerplate.
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(await errorMessage(response));
  }
  return response.json();
}

export async function apiPost(path, body) {
  // Mirror apiGet error behavior so callers handle failures uniformly.
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(await errorMessage(response));
  }
  return response.json();
}

async function errorMessage(response) {
  // Prefer structured API errors, then gracefully fall back to status text.
  try {
    const json = await response.json();
    return json.error || response.statusText;
  } catch {
    return response.statusText;
  }
}
