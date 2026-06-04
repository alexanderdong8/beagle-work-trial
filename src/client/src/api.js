export async function apiGet(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(await errorMessage(response));
  }
  return response.json();
}

export async function apiPost(path, body) {
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
  try {
    const json = await response.json();
    return json.error || response.statusText;
  } catch {
    return response.statusText;
  }
}
