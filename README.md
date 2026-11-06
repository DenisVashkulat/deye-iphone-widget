# Deye iPhone Widget

Первый каркас мониторинга DeyeCloud для iPhone.

## Уже добавлено
- Netlify Function для безопасного запроса DeyeCloud.
- Веб-страница статуса: заряд, нагрузка, генерация, мощность сети и примерная автономность.
- Скрипт виджета для Scriptable на iPhone.
- Секреты не хранятся в GitHub.

## Настройка Netlify
1. Подключи репозиторий к Netlify.
2. В Site configuration → Environment variables добавь:
   - `DEYE_APP_ID` — App ID из DeyeCloud Developer.
   - `DEYE_APP_SECRET` — App Secret.
   - `DEYE_EMAIL` — email аккаунта DeyeCloud.
   - `DEYE_PASSWORD` — пароль аккаунта DeyeCloud.
   - `DEYE_STATION_ID` — ID станции (определим отдельно).
   - `DEYE_BASE_URL` — необязательно; по умолчанию EMEA: `https://eu1-developer.deyecloud.com`.
   - `BATTERY_CAPACITY_KWH` — необязательно; по умолчанию `5.12`.
   - `BATTERY_RESERVE_PERCENT` — необязательно; по умолчанию `10`.
3. Запусти Deploy.

Важно: App Secret и пароль вводи только в Netlify Environment Variables. Не присылай их в чат и не добавляй в GitHub.

## Виджет iPhone
1. Установи Scriptable.
2. Создай Script и вставь содержимое `widget/DeyePower.js`.
3. В строке `API_URL` укажи адрес Netlify сайта с окончанием `/.netlify/functions/status`.
4. Добавь виджет Scriptable на экран и выбери этот Script.

iOS сама управляет частотой обновления виджетов. Запрос обновления через 15 минут — пожелание системе, не гарантия. Веб-страница обновляет данные раз в минуту.

## Ограничения первой версии
- Авторизация сейчас рассчитана на DeyeCloud аккаунт с email.
- Для телеметрии нужен ID станции.
- Автономность рассчитывается приблизительно по ёмкости, SOC, резерву и текущей мощности разряда.
- Определение наличия света уточним после проверки реального ответа API твоей станции.
