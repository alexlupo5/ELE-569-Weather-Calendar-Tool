# Weather-Guard Calendar (ELE 569 Weather Calendar Tool)

A calendar that checks the hourly forecast for each plan and warns you when the weather is outside the limits you set. Forecasts come from [Open-Meteo](https://open-meteo.com/), which is free and needs no API key.

The site is a single file, `src/index.html`. It can be hosted two ways on Azure:

- **Azure Storage static website** (what we use now). Upload `index.html` and you're done. The browser looks up each ZIP and calls Open-Meteo itself. This works on Azure for Students.
- **Azure Static Web Apps**, which also runs the optional backend in `api/` for server-side caching. Azure for Students subscriptions are often blocked from creating these by a region policy.

```
weather-guard/
├── src/                          ← the website (what people load)
│   ├── index.html
│   └── staticwebapp.config.json  ← Azure settings (Node 20 for the API, routing)
└── api/                          ← the backend (Azure Functions, Node.js)
    ├── host.json
    ├── package.json
    ├── local.settings.json       ← only used when running on your Mac
    └── src/
        ├── functions/forecast.js ← GET /api/forecast?zip=02816
        └── lib/weather.js        ← Open-Meteo calls + data conversion
```

## How it works

1. For each ZIP code with upcoming plans, the page first tries `/api/forecast?zip=…`.
2. On a storage website there is no `/api`, so the page does the work itself. It looks up the ZIP's coordinates with Open-Meteo's geocoding API (Zippopotam.us is the backup), then gets a 16-day hourly forecast: temperature, rain chance, wind, gusts and weather code.
3. Coordinates are remembered in the browser, and forecasts are reused for 15 minutes. All plans in the same ZIP share one forecast.
4. The page compares every hour of each plan against its limits.

The header says **Live forecast** once real data has loaded. If the weather service can't be reached or a ZIP doesn't exist, the plan says **Forecast unavailable** with the reason. The page never shows made-up weather.

## Put it on an Azure Storage static website

1. In the [Azure portal](https://portal.azure.com), choose **Create a resource → Storage account**. Use **Primary service:** Azure Blob Storage, **Performance:** Standard, **Redundancy:** LRS, and a region your subscription allows.
2. Open the storage account, then go to **Data management → Static website**. Set it to **Enabled**, enter `index.html` as the index document, and click **Save**. The **Primary endpoint** is the site's address.
3. Go to **Data storage → Containers → $web**, click **Upload**, and choose `src/index.html`. When updating, tick **Overwrite if files already exist**.

That's all. `staticwebapp.config.json` and the `api/` folder aren't used on a storage website.

## Run it on your Mac

To try just the page, double-click `src/index.html`. It works the same as on the storage website.

To run the page together with the backend, you need Node.js 20 or newer, the Static Web Apps CLI and Azure Functions Core Tools.

```bash
# one-time setup
brew install node
npm install -g @azure/static-web-apps-cli
brew tap azure/functions
brew install azure-functions-core-tools@4

# install the API's one dependency
cd weather-guard/api
npm install
cd ..

# start the site and the API together
swa start src --api-location api
```

Open **http://localhost:4280**. The header should say **Live forecast**. To check the API by itself, open http://localhost:4280/api/forecast?zip=02816 and you should see JSON.

## Put it on Azure Static Web Apps (optional, with the backend)

Azure Static Web Apps' **Free** plan includes the API, so this costs nothing. If you get "Resource was disallowed by Azure", your subscription's region policy doesn't allow Static Web Apps; use the storage website instead.

1. **Push the folder to GitHub.** Create a new repository and push the whole `weather-guard` folder (the `node_modules` folder is ignored).
2. **Create the Static Web App.** In the [Azure portal](https://portal.azure.com), choose **Create a resource → Static Web App** and fill in:
   - **Plan type:** Free
   - **Source:** GitHub. Sign in, then pick your repository and the `main` branch.
   - **Build Presets:** Custom
   - **App location:** `/src`
   - **Api location:** `/api`
   - **Output location:** leave empty
3. **Click Review + create, then Create.** Azure adds a GitHub Actions workflow to your repository and starts the first deployment. It takes a couple of minutes, and you can watch it in the repository's **Actions** tab.
4. **Open the site.** The URL (`https://<random-name>.azurestaticapps.net`) is on the Static Web App's **Overview** page. Check that the header says **Live forecast**.

After that, every push to `main` redeploys the site automatically.

## Good to know

- **Open-Meteo's free API is for non-commercial use.** That covers a personal or class project. Commercial use needs a paid API key. The backend supports one through an `OPEN_METEO_API_KEY` setting; a key should never be put in `index.html`, because anyone can read it there.
- **Plans are saved in each person's browser** (localStorage) for now. To share plans across devices, add a database (Azure Table Storage or Cosmos DB) and replace the three methods in the `Store` object near the top of the page's script with calls to new API routes such as `GET /api/plans` and `PUT /api/plans`.
- **Alerts are only logged on the page.** Sending real texts or emails needs a timer-triggered Function that checks every plan hourly and sends through Azure Communication Services. That piece would go in a separate Azure Functions app, which also works on Azure for Students.
- **Forecast range:** Open-Meteo goes 16 days ahead. Plans further out show "No forecast yet" until they're in range. Rain chance isn't always available for the last days of the range, and the page shows "Not yet" when it's missing.
