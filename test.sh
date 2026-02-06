curl -X POST http://localhost:3000/api/sprint-stats \
  -H "Content-Type: application/json" \
  -H "x-jira-domain: https://your-domain.atlassian.net" \
  -H "x-jira-email: you@example.com" \
  -H "x-jira-token: YOUR_API_TOKEN" \
  -d '{
    "boardId": 12,
    "sprintCount": 4
  }'