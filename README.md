# Weather-Guard Calendar (ELE 569 Weather Calendar Tool)

A calendar that checks the hourly forecast for each plan and warns you when the weather is outside the limits you set. Forecasts come from [Open-Meteo](https://open-meteo.com/), which is free and needs no API key.

It has two parts, both on Azure:

| Part | What it is | Azure service |
|---|---|---|
| **The website** (`src/index.html`) | The calendar people see | Storage account → Static website |
| **The backend** (`api/`) | Saves the plans and checks the weather **every 30 minutes, even when nobody has the site open** | Function App |

```
src/index.html                  ← the whole website (one file)
api/                            ← the Function App (Node.js)
├── package.json, host.json
└── src/
    ├── functions/
    │   ├── check.js            ← timer: weather check every 30 min; POST /api/check
    │   ├── plans.js            ← GET /api/plans, PUT/DELETE /api/plans/{id}
    │   └── forecast.js         ← GET /api/forecast?zip=02816
    └── lib/
        ├── checker.js          ← the weather check itself
        ├── rules.js            ← limit checks (same rules as the page)
        ├── weather.js          ← Open-Meteo calls
        └── store.js            ← saves JSON files in Blob Storage
```

## How it works

- **Saving:** plans are saved in a private Blob Storage container named `weatherguard-data`, in your storage account. It holds `plans.json`, `alerts.json`, `status.json` and one `forecasts/<zip>.json` per ZIP. Every browser and device sees the same plans.
- **The 30-minute check:** a timer runs at :00 and :30 every hour, whether or not anyone has the site open. It downloads a fresh 16-day hourly forecast for each ZIP with upcoming plans, works out each plan's status, notes what changed, and adds an entry to the alert log when a plan turns bad or clears up.
- **The page:** loads the plans, latest forecasts and alert log from the Function App. It reloads them every 30 minutes, and right away when you come back to the tab. The header shows when the weather was last updated; hover over **Saved in Azure** to see when the last background check ran.
- **Without the backend:** if `API_BASE` in `index.html` is left empty, the page works on its own. Plans are kept in that browser only, and the weather is only checked while the page is open.

## Set up the backend (one time)

You need the storage account you already have (`weathercalendartool`) and about 15 minutes.

### 1. Create the Function App

In the [Azure portal](https://portal.azure.com), choose **Create a resource → Function App**.

- **Hosting plan:** Flex Consumption. If your region doesn't offer it, choose Consumption.
- **Resource group:** the same one as your storage account
- **Function App name:** something unique, like `weatherguard-api-alex`
- **Region:** one your subscription allows (the same as your storage account is easiest)
- **Runtime stack:** Node.js, **Version:** 20 or 22
- On the **Storage** tab, pick your existing storage account (`weathercalendartool`).

Click **Review + create**, then **Create**. When it's done, open the Function App and copy its **Default domain** from the **Overview** page. It looks like `weatherguard-api-alex-xxxx.eastus2-01.azurewebsites.net`.

### 2. Tell it where to save data

1. Open your storage account (`weathercalendartool`) and go to **Security + networking → Access keys**. Click **Show** next to the first **Connection string** and copy it.
2. Open the Function App and go to **Settings → Environment variables**. Under **App settings**, add:

| Name | Value |
|---|---|
| `DATA_STORAGE_CONNECTION` | the connection string you copied |
| `ACCESS_CODE` | *(optional)* a password people must enter to see and edit the calendar |
| `DEFAULT_TIMEZONE` | *(optional)* `America/New_York`, used before a ZIP's forecast is known |

Click **Apply**, then **Confirm**.

### 3. Let the website call the backend (CORS)

In the Function App, go to **API → CORS**. Add your website's address with no slash at the end, and click **Save**:

```
https://weathercalendartool.z55.web.core.windows.net
```

### 4. Upload the backend code

On your Mac, in Terminal:

```bash
# one-time setup
brew install azure-cli
brew tap azure/functions
brew install azure-functions-core-tools@4
az login

# from the repository folder
cd ELE-569-Weather-Calendar-Tool/api
npm install
func azure functionapp publish weatherguard-api-alex
```

Use your own Function App name in the last line. When it finishes, it lists the functions: `checkNow`, `checkWeather`, `deletePlan`, `forecast`, `listPlans` and `savePlan`.

You can also deploy from VS Code: install the **Azure Functions** extension, right-click the `api` folder and choose **Deploy to Function App**.

Check that it works by opening `https://<your default domain>/api/forecast?zip=02816` in a browser. You should see weather data as JSON.

### 5. Point the website at the backend

Open `src/index.html`, find this line near the top of the script, and put in your default domain followed by `/api`:

```js
const API_BASE = 'https://weatherguard-api-alex-xxxx.eastus2-01.azurewebsites.net/api';
```

Upload the file to your storage account's **$web** container, ticking **Overwrite if files already exist**. Then open the site and press ⌘⇧R. The header should say **Saved in Azure** and **Live forecast**.

**Plans saved in your browser before this aren't copied over**, so add them again.

## Checking on it

- **Did the timer run?** On the site, hover over **Saved in Azure** to see the last background check. In the portal, open the Function App → **checkWeather** → **Invocations**.
- **Where's the data?** Storage account → **Containers → weatherguard-data**.
- **Something's wrong?** The Function App's **Log stream** shows errors as they happen. If the page says it can't reach Azure, check the CORS address (step 3) and `API_BASE` (step 5).

## Good to know

- **Cost:** the timer runs 48 times a day, which should stay within the Function App's free monthly allowance. Storage costs cents.
- **The access code is light protection.** It keeps strangers from editing your calendar, but it isn't a full login system. Anyone you give the site and code to can see and edit every plan.
- **Alerts are logged, not sent yet.** To send emails, add Azure Communication Services and send from the marked spot in `api/src/lib/checker.js`, where each new alert is logged.
- **Open-Meteo's free API is for non-commercial use**, which covers a class project. For a paid key, add an `OPEN_METEO_API_KEY` app setting.
- **Forecast range:** Open-Meteo goes 16 days ahead. Plans further out say "No forecast yet" until they're in range.

## Run it on your Mac (optional)

Leave `API_BASE` empty and double-click `src/index.html` for the browser-only version.

To run the backend locally, put your storage connection string in both `AzureWebJobsStorage` and `DATA_STORAGE_CONNECTION` in `api/local.settings.json`. Then run `npm install` and `func start` in the `api` folder. The API runs at `http://localhost:7071/api`, so set `API_BASE` to that while testing.
