# Weather-Guard Calendar (ELE 569 Weather Calendar Tool)

A calendar that checks the hourly forecast for each plan and warns you when the weather is outside the limits you set. Forecasts come from [Open-Meteo](https://open-meteo.com/) (free, no API key) through a small Azure Function, and the site is hosted on Azure Static Web Apps.

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

1. The page asks `/api/forecast?zip=02816` for each ZIP code that has upcoming plans.
2. The Function looks up the ZIP's coordinates with Open-Meteo's geocoding API (Zippopotam.us is the backup), then gets a 16-day hourly forecast: temperature, rain chance, wind, gusts and weather code.
3. It caches each forecast for 30 minutes, so plans in the same ZIP and repeat visits don't call Open-Meteo again.
4. The page compares every hour of each plan against its limits.

If the page can't find `/api` (for example, you double-click `index.html`), it calls Open-Meteo directly from the browser. If that fails too, it shows made-up weather and says **Demo weather** in the header, so you'll always know which one you're looking at.

## Run it on your Mac

You need Node.js 20 or newer, the Static Web Apps CLI and Azure Functions Core Tools.

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

## Put it on Azure

Azure Static Web Apps' **Free** plan includes the API, so this costs nothing.

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

- **Open-Meteo's free API is for non-commercial use.** That covers a personal or class project. For commercial use, buy an API key and add it in the Static Web App under **Settings → Environment variables** as `OPEN_METEO_API_KEY`. The Function switches to the paid servers on its own.
- **Plans are saved in each person's browser** (localStorage) for now. To share plans across devices, add a database (Azure Table Storage or Cosmos DB) and replace the three methods in the `Store` object near the top of the page's script with calls to new API routes such as `GET /api/plans` and `PUT /api/plans`.
- **Alerts are only logged on the page.** Sending real texts or emails needs a timer-triggered Function that checks every plan hourly and sends through Azure Communication Services. Managed Static Web Apps functions only support HTTP triggers, so that piece would go in a separate Azure Functions app.
- **Forecast range:** Open-Meteo goes 16 days ahead. Plans further out show "No forecast yet" until they're in range. Rain chance isn't always available for the last days of the range, and the page shows "Not yet" when it's missing.
