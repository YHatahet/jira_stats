const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

// --- HELPER: Pagination Logic ---
async function fetchAllPaginated(url, params, authConfig) {
    let results = [];
    let startAt = 0;
    let isLast = false;
    const maxResults = 50; // Safe Jira default

    // Create a request instance for this specific call
    const client = axios.create({
        baseURL: authConfig.domain,
        headers: {
            'Authorization': `Basic ${Buffer.from(`${authConfig.email}:${authConfig.token}`).toString('base64')}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        }
    });

    console.log(`[Fetching] ${url}`);

    while (!isLast) {
        try {
            const response = await client.get(url, {
                params: { ...params, startAt, maxResults }
            });

            const data = response.data;
            const pageValues = data.values || data.issues || [];

            results = results.concat(pageValues);

            if (data.isLast === undefined) {
                // Fallback if 'isLast' is missing
                if (startAt + pageValues.length >= (data.total || 0)) isLast = true;
            } else {
                isLast = data.isLast;
            }

            startAt += pageValues.length;

            // Safety break for extremely large datasets to prevent timeouts
            if (startAt > 2000) {
                console.warn('Hit safety limit of 2000 items');
                isLast = true;
            }

        } catch (error) {
            // Throw up to the main handler
            throw new Error(`Jira API Error at startAt ${startAt}: ${error.message}`);
        }
    }
    return results;
}

// --- ROUTE: POST /api/sprint-stats ---
app.post('/api/sprint-stats', async (req, res) => {
    try {
        // 1. Extract Credentials (support Headers or Body, Headers preferred)
        const domain = req.headers['x-jira-domain'] || req.body.domain;
        const email = req.headers['x-jira-email'] || req.body.email;
        const token = req.headers['x-jira-token'] || req.body.token;

        // 2. Extract Logic Params
        const boardId = req.body.boardId;
        const sprintCount = req.body.sprintCount || 3;
        // Default to customfield_10002 (common for Story Points), but allow override
        const storyPointField = req.body.storyPointField || 'customfield_10002';

        // Validation
        if (!domain || !email || !token || !boardId) {
            return res.status(400).json({
                error: "Missing required fields. Ensure domain, email, token, and boardId are provided."
            });
        }

        const authConfig = { domain, email, token };

        // 3. Fetch All Closed Sprints
        const allSprints = await fetchAllPaginated(
            `/rest/agile/1.0/board/${boardId}/sprint`,
            { state: 'closed' },
            authConfig
        );

        // 4. Sort and Slice
        const sortedSprints = allSprints.sort((a, b) => new Date(a.endDate) - new Date(b.endDate));
        const lastSprints = sortedSprints.slice(-sprintCount);

        const dashboardData = [];

        // 5. Process Sprints
        for (const sprint of lastSprints) {
            const issues = await fetchAllPaginated(
                `/rest/agile/1.0/sprint/${sprint.id}/issue`,
                { fields: `status,${storyPointField},summary` },
                authConfig
            );

            let totalPoints = 0;
            let completedPoints = 0;
            let totalIssues = issues.length;
            let completedIssues = 0;

            issues.forEach(issue => {
                const points = issue.fields[storyPointField] || 0;
                const statusCategory = issue.fields.status.statusCategory.key; // 'new', 'indeterminate', 'done'

                totalPoints += points;

                if (statusCategory === 'done') {
                    completedPoints += points;
                    completedIssues++;
                }
            });

            dashboardData.push({
                sprintName: sprint.name,
                sprintId: sprint.id,
                endDate: sprint.endDate,
                stats: {
                    committedPoints: totalPoints,
                    completedPoints: completedPoints,
                    completionRate: totalPoints > 0 ? parseFloat(((completedPoints / totalPoints) * 100).toFixed(1)) : 0,
                    totalIssues: totalIssues,
                    issuesDone: completedIssues
                }
            });
        }

        return res.json({
            meta: {
                boardId: boardId,
                scannedSprints: lastSprints.length
            },
            data: dashboardData
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Jira Stats Service running on port ${PORT}`);
});