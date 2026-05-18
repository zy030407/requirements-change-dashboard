const baseUrl = process.env.API_BASE_URL || "http://127.0.0.1:4000";

async function main() {
  const health = await fetch(`${baseUrl}/api/health`);
  assert(health.ok, "health endpoint failed");

  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account: "pm", password: "pm123" })
  });
  assert(loginResponse.ok, "login endpoint failed");
  const { token } = await loginResponse.json();
  const authHeaders = { Authorization: `Bearer ${token}` };

  const projectsResponse = await fetch(`${baseUrl}/api/projects`, { headers: authHeaders });
  assert(projectsResponse.ok, "projects endpoint failed");
  const { projects } = await projectsResponse.json();
  assert(projects.length > 0, "expected seeded project");

  const projectId = projects[0].id;
  const dashboardResponse = await fetch(`${baseUrl}/api/projects/${projectId}/dashboard`, { headers: authHeaders });
  assert(dashboardResponse.ok, "dashboard endpoint failed");
  const dashboard = await dashboardResponse.json();
  assert(dashboard.metrics.requirementTotal >= 1, "expected requirements in dashboard");

  const wikiResponse = await fetch(`${baseUrl}/api/projects/${projectId}/wiki`, { headers: authHeaders });
  assert(wikiResponse.ok, "wiki endpoint failed");
  const wiki = await wikiResponse.json();
  assert(wiki.pages.length >= 1, "expected wiki pages");

  const suggestionResponse = await fetch(`${baseUrl}/api/projects/${projectId}/requirement-suggestions`, { headers: authHeaders });
  assert(suggestionResponse.ok, "requirement suggestions endpoint failed");
  const suggestions = await suggestionResponse.json();
  assert(Array.isArray(suggestions.suggestions), "expected requirement suggestions array");

  console.log("Smoke test passed");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
