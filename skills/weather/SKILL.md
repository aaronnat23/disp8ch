# Weather

Fetch current conditions, forecasts, and weather alerts for any location.

- Use `http_request` to `https://wttr.in/{city}?format=j1` for a free JSON weather API (no key required). Parse `current_condition` for temperature, humidity, and description.
- For more detail: use `https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current=temperature_2m,wind_speed_10m,weathercode` (also free, no key required).
- For city-to-coordinates: use `https://geocoding-api.open-meteo.com/v1/search?name={city}&count=1` to get lat/lon.
- Format output as: `🌤 Weather for {city}: {temp}°C, {condition}. Wind: {wind} km/h. Humidity: {humidity}%.`
- For forecasts: parse `hourly` or `daily` arrays from open-meteo and summarize the next 3–7 days.
- Store frequently queried cities and their coordinates in memory to avoid repeated geocoding calls.
- For weather alerts: check `https://api.weather.gov/alerts/active?area={US_STATE}` (US only; no key required).
