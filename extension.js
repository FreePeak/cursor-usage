const vscode = require('vscode');
const https = require('https');
const { execFile } = require('child_process');
const path = require('path');
const os = require('os');

let statusBarItem;
let refreshInterval;

const API_HOST = 'cursor.com';
const USAGE_PATH = '/api/usage';
const INVOICE_PATH = '/api/dashboard/get-monthly-invoice';

function getConfig() {
	const cfg = vscode.workspace.getConfiguration('cursorUsage');
	return {
		sessionToken: cfg.get('sessionToken', ''),
		refreshIntervalMinutes: cfg.get('refreshIntervalMinutes', 15),
		autoDetectToken: cfg.get('autoDetectToken', true),
	};
}

function setSessionToken(token) {
	return vscode.workspace.getConfiguration('cursorUsage')
		.update('sessionToken', token, vscode.ConfigurationTarget.Global);
}

function getCursorDbPath() {
	const home = os.homedir();
	switch (process.platform) {
		case 'darwin':
			return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
		case 'linux':
			return path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
		case 'win32':
			return path.join(process.env.APPDATA || '', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
		default:
			return '';
	}
}

function getChromeCookiePath() {
	const home = os.homedir();
	switch (process.platform) {
		case 'darwin':
			return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Cookies');
		case 'linux':
			return path.join(home, '.config', 'google-chrome', 'Default', 'Cookies');
		case 'win32':
			return path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data', 'Default', 'Cookies');
		default:
			return '';
	}
}

function getEdgeCookiePath() {
	const home = os.homedir();
	switch (process.platform) {
		case 'darwin':
			return path.join(home, 'Library', 'Application Support', 'Microsoft Edge', 'Default', 'Cookies');
		case 'linux':
			return path.join(home, '.config', 'microsoft-edge', 'Default', 'Cookies');
		case 'win32':
			return path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data', 'Default', 'Cookies');
		default:
			return '';
	}
}

function tryExtractFromBrowserCookies() {
	return new Promise((resolve) => {
		const cookiePaths = [
			{ name: 'Chrome', path: getChromeCookiePath() },
			{ name: 'Edge', path: getEdgeCookiePath() },
		];

		for (const browser of cookiePaths) {
			if (browser.path) {
				try {
					if (require('fs').existsSync(browser.path)) {
						console.log(`[Cursor Usage] Found ${browser.name} cookie database at ${browser.path}`);
					}
				} catch (e) {
				}
			}
		}

		resolve(null);
	});
}

function decodeJwtPayload(jwt) {
	const parts = jwt.split('.');
	if (parts.length !== 3) {
		throw new Error('Invalid JWT format');
	}
	let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
	while (payload.length % 4 !== 0) {
		payload += '=';
	}
	return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
}

function extractUserIdFromToken(accessToken) {
	const decoded = decodeJwtPayload(accessToken);
	const sub = decoded.sub || '';
	return sub.includes('|') ? sub.split('|')[1] : sub;
}

function buildCookie(userId, accessToken) {
	return `WorkosCursorSessionToken=${userId}%3A%3A${accessToken}`;
}

function extractTokenFromDb() {
	return new Promise((resolve, reject) => {
		const dbPath = getCursorDbPath();
		if (!dbPath) {
			reject(new Error('Unsupported platform for auto-detection'));
			return;
		}

		const query = "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'";
		execFile('sqlite3', [dbPath, query], { timeout: 5000 }, (err, stdout) => {
			if (err) {
				reject(new Error(`sqlite3 error: ${err.message}. Make sure sqlite3 is installed (brew install sqlite3 on macOS) or set token manually via "Cursor Usage: Set Session Token" command.`));
				return;
			}
			const token = stdout.trim();
			if (token) {
				resolve(token);
			} else {
				reject(new Error('No token in Cursor database. Open cursor.com, login, then restart Cursor. Or use "Cursor Usage: Set Session Token" to enter manually.'));
			}
		});
	});
}

async function getAuthInfo() {
	const config = getConfig();
	let accessToken = config.sessionToken;

	if (!accessToken && config.autoDetectToken) {
		try {
			accessToken = await extractTokenFromDb();
		} catch (e) {
			console.log('[Cursor Usage] Auto-detect failed:', e.message);
			return null;
		}
	}

	if (!accessToken) {
		return null;
	}

	try {
		const userId = extractUserIdFromToken(accessToken);
		return { userId, accessToken, cookie: buildCookie(userId, accessToken) };
	} catch (e) {
		console.log('[Cursor Usage] Token decode failed:', e.message);
		return null;
	}
}

function httpRequest(options, body, redirectsLeft) {
	if (redirectsLeft === undefined) redirectsLeft = 3;
	return new Promise((resolve, reject) => {
		const req = https.request(options, (res) => {
			let data = '';
			res.on('data', chunk => data += chunk);
			res.on('end', () => {
				if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
					const redirectUrl = new URL(res.headers.location, `https://${options.hostname}`);
					const redirectOptions = {
						...options,
						hostname: redirectUrl.hostname,
						path: redirectUrl.pathname + redirectUrl.search,
					};
					httpRequest(redirectOptions, body, redirectsLeft - 1).then(resolve).catch(reject);
					return;
				}
				if (res.statusCode === 200) {
					resolve(data);
				} else if (res.statusCode === 401 || res.statusCode === 403) {
					reject(new Error(`Auth failed (${res.statusCode}). Run "Set Cursor Session Token" or check auto-detect.`));
				} else {
					reject(new Error(`API returned ${res.statusCode}: ${data.substring(0, 200)}`));
				}
			});
		});
		req.on('error', reject);
		req.setTimeout(15000, () => {
			req.destroy();
			reject(new Error('Request timeout'));
		});
		if (body) {
			req.write(body);
		}
		req.end();
	});
}

async function fetchUsage(auth) {
	const data = await httpRequest({
		hostname: API_HOST,
		port: 443,
		path: `${USAGE_PATH}?user=${encodeURIComponent(auth.userId)}`,
		method: 'GET',
		headers: {
			'Accept': 'application/json',
			'Cookie': auth.cookie,
		},
	});

	console.log('[Cursor Usage] /api/usage response:', data);
	const parsed = JSON.parse(data);

	let totalRequests = 0;
	let maxRequests = null;
	const startOfMonth = parsed.startOfMonth || null;
	const models = {};

	for (const [key, value] of Object.entries(parsed)) {
		if (key === 'startOfMonth') continue;
		if (typeof value === 'object' && value !== null && value.numRequests !== undefined) {
			models[key] = value;
			totalRequests += value.numRequests || 0;
			if (value.maxRequestUsage != null && (maxRequests === null || value.maxRequestUsage > maxRequests)) {
				maxRequests = value.maxRequestUsage;
			}
		}
	}

	return { totalRequests, maxRequests, startOfMonth, models };
}

async function fetchInvoice(auth) {
	const body = JSON.stringify({ includeUsageEvents: false });
	const data = await httpRequest({
		hostname: API_HOST,
		port: 443,
		path: INVOICE_PATH,
		method: 'POST',
		headers: {
			'Accept': 'application/json',
			'Content-Type': 'application/json',
			'Cookie': auth.cookie,
			'Origin': 'https://cursor.com',
		},
	}, body);

	console.log('[Cursor Usage] invoice response:', data);
	const parsed = JSON.parse(data);

	let totalCents = 0;
	const items = parsed.items || [];
	for (const item of items) {
		totalCents += item.cents || 0;
	}

	return { totalCents, items };
}

function formatCurrency(cents) {
	return `$${(cents / 100).toFixed(2)}`;
}

function ensureStatusBar() {
	if (!statusBarItem) {
		statusBarItem = vscode.window.createStatusBarItem(
			'cursor-usage-status',
			vscode.StatusBarAlignment.Left,
			100
		);
		statusBarItem.command = 'cursor-usage.refresh';
	}
	return statusBarItem;
}

async function updateStatusBar() {
	const bar = ensureStatusBar();
	const auth = await getAuthInfo();

	if (!auth) {
		bar.text = '$(key) Cursor: No Token';
		bar.tooltip = 'Click to refresh, or run "Cursor Usage: Set Session Token"';
		bar.color = undefined;
		bar.show();
		return;
	}

	bar.text = '$(sync~spin) Cursor: ...';
	bar.tooltip = 'Fetching usage...';
	bar.color = undefined;
	bar.show();

	try {
		const [usageResult, invoiceResult] = await Promise.allSettled([
			fetchUsage(auth),
			fetchInvoice(auth),
		]);

		const parts = [];
		const tooltipLines = [];

		if (usageResult.status === 'fulfilled') {
			const u = usageResult.value;
			if (u.maxRequests != null) {
				parts.push(`${u.totalRequests}/${u.maxRequests}`);
			} else {
				parts.push(`${u.totalRequests} reqs`);
			}

			tooltipLines.push('--- Request Usage ---');
			const now = new Date();
			const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
			const daysLeftInMonth = lastDayOfMonth - now.getDate() + 1;
			for (const [model, info] of Object.entries(u.models)) {
				if (model === 'gpt-4' && info.maxRequestUsage != null) {
					const remaining = info.maxRequestUsage - info.numRequests;
					const avgPerDay = daysLeftInMonth > 0 ? (remaining / daysLeftInMonth).toFixed(1) : 0;
					tooltipLines.push(`  ${model}: Remaining ${remaining} reqs (avg ${avgPerDay}/day)`);
				} else {
					const limit = info.maxRequestUsage != null ? `/${info.maxRequestUsage}` : '';
					tooltipLines.push(`  ${model}: ${info.numRequests}${limit} reqs`);
				}
			}
			if (u.startOfMonth) {
				tooltipLines.push(`  Billing cycle start: ${new Date(u.startOfMonth).toLocaleDateString()}`);
			}
		} else {
			parts.push('? reqs');
			tooltipLines.push(`Usage error: ${usageResult.reason?.message || 'unknown'}`);
		}

		if (invoiceResult.status === 'fulfilled' && invoiceResult.value.totalCents > 0) {
			parts.push(formatCurrency(invoiceResult.value.totalCents));
			tooltipLines.push('');
			tooltipLines.push('--- Extra Charges ---');
			for (const item of invoiceResult.value.items) {
				tooltipLines.push(`  ${item.description}: ${formatCurrency(item.cents)}`);
			}
		}

		tooltipLines.push('');
		tooltipLines.push(`Updated: ${new Date().toLocaleTimeString()}`);
		tooltipLines.push('Click to refresh');

		bar.text = `$(dashboard) Cursor: ${parts.join(' | ')}`;
		bar.color = undefined;
		bar.tooltip = tooltipLines.join('\n');
	} catch (error) {
		bar.text = '$(error) Cursor: Error';
		bar.color = new vscode.ThemeColor('errorForeground');
		bar.tooltip = error.message;
	}
}

function startRefreshTimer() {
	if (refreshInterval) {
		clearInterval(refreshInterval);
	}
	const minutes = getConfig().refreshIntervalMinutes;
	refreshInterval = setInterval(() => updateStatusBar(), minutes * 60 * 1000);
}

function activate(context) {
	const disposableSetToken = vscode.commands.registerCommand('cursor-usage.setToken', async () => {
		const current = getConfig().sessionToken;
		const input = await vscode.window.showInputBox({
			prompt: 'Paste your WorkosCursorSessionToken or the raw JWT access token from Cursor database',
			value: current,
			placeHolder: 'eyJhbGciOiJSUzI1NiIs...',
			password: true,
		});

		if (input !== undefined) {
			let cleaned = input.replace(/^WorkosCursorSessionToken=/, '').trim();
			
			// If the user pasted the full cookie value containing the user ID prefix (e.g. user_123::eyJ... or user_123%3A%3AeyJ...)
			// we need to extract just the JWT part.
			if (cleaned.includes('%3A%3A')) {
				cleaned = cleaned.split('%3A%3A')[1];
			} else if (cleaned.includes('::')) {
				cleaned = cleaned.split('::')[1];
			}

			await setSessionToken(cleaned);
			vscode.window.showInformationMessage('Session token saved');
			updateStatusBar();
		}
	});

	const disposableRefresh = vscode.commands.registerCommand('cursor-usage.refresh', () => {
		updateStatusBar();
	});

	const disposableClearToken = vscode.commands.registerCommand('cursor-usage.clearToken', async () => {
		await setSessionToken('');
		vscode.window.showInformationMessage('Session token cleared. Will use auto-detect if enabled.');
		updateStatusBar();
	});

	context.subscriptions.push(disposableSetToken, disposableRefresh, disposableClearToken);

	updateStatusBar();
	startRefreshTimer();
}

function deactivate() {
	if (refreshInterval) {
		clearInterval(refreshInterval);
	}
}

module.exports = { activate, deactivate };
