#!/usr/bin/env python3
"""Read group IDs from the bot's recent updates. The token is never saved or printed."""
import getpass
import json
import urllib.error
import urllib.request

def main():
    token = getpass.getpass('Новый токен бота (ввод скрыт): ').strip()
    if not token or any(c.isspace() for c in token):
        raise SystemExit('Некорректный токен.')
    def api(method, payload):
        request = urllib.request.Request('https://api.telegram.org/bot' + token + '/' + method,
            data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                result = json.load(response)
        except (urllib.error.URLError, ValueError):
            raise SystemExit('Не удалось обратиться к Telegram. Проверьте токен и подключение.') from None
        if not result.get('ok'):
            raise SystemExit('Telegram отклонил запрос. Проверьте токен и настройки бота.')
        return result['result']
    bot = api('getMe', {})
    print('Бот: @' + bot.get('username', ''))
    if api('getWebhookInfo', {}).get('url'):
        raise SystemExit('У бота уже настроен webhook. Он не изменён. Получите chat_id через существующий обработчик.')
    groups = {}
    for update in api('getUpdates', {'limit': 100, 'timeout': 0}):
        for key in ('message', 'my_chat_member', 'chat_member'):
            chat = update.get(key, {}).get('chat', {})
            if chat.get('type') in ('group', 'supergroup'):
                groups[chat['id']] = chat.get('title', 'Группа')
    if not groups:
        print('Добавьте бота в группу, отправьте в ней /start@' + bot.get('username', '') + ' и повторите команду.')
    for chat_id, title in groups.items():
        print(f'{title}: {chat_id}')

if __name__ == '__main__':
    main()
