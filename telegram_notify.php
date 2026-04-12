<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    http_response_code(405);
    echo json_encode(['ok' => false, 'error' => 'method_not_allowed'], JSON_UNESCAPED_UNICODE);
    exit;
}

$raw = file_get_contents('php://input');
if ($raw === false) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'invalid_json'], JSON_UNESCAPED_UNICODE);
    exit;
}
if (strlen($raw) > 65536) {
    http_response_code(413);
    echo json_encode(['ok' => false, 'error' => 'payload_too_large'], JSON_UNESCAPED_UNICODE);
    exit;
}

$payload = json_decode($raw, true);
if (!is_array($payload)) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'invalid_json'], JSON_UNESCAPED_UNICODE);
    exit;
}

if (trim((string)($payload['website'] ?? '')) !== '') {
    echo json_encode(['ok' => true], JSON_UNESCAPED_UNICODE);
    exit;
}

function client_ip(): string
{
    $xff = $_SERVER['HTTP_X_FORWARDED_FOR'] ?? '';
    if (is_string($xff) && $xff !== '') {
        $parts = explode(',', $xff);
        $ip = trim($parts[0]);
        if (filter_var($ip, FILTER_VALIDATE_IP)) {
            return $ip;
        }
    }
    $ip = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';

    return is_string($ip) ? $ip : '0.0.0.0';
}

/**
 * Простой лимит: не более $max запросов за $windowSec секунд с одного IP.
 */
function rate_limit_allow(string $ip, int $max, int $windowSec): bool
{
    $dir = __DIR__ . DIRECTORY_SEPARATOR . '.lead_rl';
    if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
        return true;
    }
    $safe = preg_replace('/[^a-f0-9]/', '', hash('sha256', $ip));
    if ($safe === '') {
        $safe = 'unknown';
    }
    $file = $dir . DIRECTORY_SEPARATOR . $safe . '.json';
    $now = time();
    $times = [];
    if (is_file($file)) {
        $json = @file_get_contents($file);
        if (is_string($json) && $json !== '') {
            $decoded = json_decode($json, true);
            if (is_array($decoded)) {
                foreach ($decoded as $t) {
                    if (is_int($t) || is_float($t)) {
                        $ti = (int)$t;
                        if ($ti > $now - $windowSec) {
                            $times[] = $ti;
                        }
                    }
                }
            }
        }
    }
    if (count($times) >= $max) {
        return false;
    }
    $times[] = $now;
    @file_put_contents($file, json_encode($times), LOCK_EX);

    return true;
}

$ip = client_ip();
if (!rate_limit_allow($ip, 12, 300)) {
    http_response_code(429);
    echo json_encode(['ok' => false, 'error' => 'rate_limited'], JSON_UNESCAPED_UNICODE);
    exit;
}

$name = trim((string)($payload['name'] ?? ''));
$phone = trim((string)($payload['phone'] ?? ''));
$comment = trim((string)($payload['comment'] ?? ''));
$context = trim((string)($payload['context'] ?? ''));
$contact = trim((string)($payload['contact'] ?? ''));

$nameLen = function_exists('mb_strlen') ? mb_strlen($name) : strlen($name);
if ($name === '' || $nameLen > 120) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'invalid_name'], JSON_UNESCAPED_UNICODE);
    exit;
}

$digits = preg_replace('/\D/', '', $phone) ?? '';
if (strlen($digits) < 10) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'invalid_phone'], JSON_UNESCAPED_UNICODE);
    exit;
}

$commentMax = 2000;
$contextMax = 500;
$contactMax = 80;
if ((function_exists('mb_strlen') ? mb_strlen($comment) : strlen($comment)) > $commentMax) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'invalid_comment'], JSON_UNESCAPED_UNICODE);
    exit;
}
if ((function_exists('mb_strlen') ? mb_strlen($context) : strlen($context)) > $contextMax) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'invalid_context'], JSON_UNESCAPED_UNICODE);
    exit;
}
if ((function_exists('mb_strlen') ? mb_strlen($contact) : strlen($contact)) > $contactMax) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'invalid_contact'], JSON_UNESCAPED_UNICODE);
    exit;
}

$configPath = __DIR__ . DIRECTORY_SEPARATOR . 'telegram_config.php';
if (!is_file($configPath)) {
    http_response_code(503);
    echo json_encode(['ok' => false, 'error' => 'config_missing'], JSON_UNESCAPED_UNICODE);
    exit;
}

$config = require $configPath;
if (!is_array($config)) {
    http_response_code(503);
    echo json_encode(['ok' => false, 'error' => 'config_missing'], JSON_UNESCAPED_UNICODE);
    exit;
}

$token = trim((string)($config['bot_token'] ?? ''));
$chatId = trim((string)($config['chat_id'] ?? ''));
if ($token === '' || $chatId === '') {
    http_response_code(503);
    echo json_encode(['ok' => false, 'error' => 'telegram_not_configured'], JSON_UNESCAPED_UNICODE);
    exit;
}

$contactLabels = ['telegram' => 'Telegram', 'whatsapp' => 'WhatsApp', 'max' => 'MAX', 'call' => 'Звонок'];
$contactHuman = $contactLabels[$contact] ?? $contact;

$lines = [
    'СтройФаст — заявка с сайта',
    'Имя: ' . $name,
    'Телефон: ' . $phone,
];
if ($context !== '') {
    $lines[] = 'Тема: ' . $context;
}
if ($comment !== '') {
    $lines[] = 'Комментарий: ' . $comment;
}
if ($contact !== '') {
    $lines[] = 'Связь: ' . $contactHuman;
}
$text = implode("\n", $lines);
if ((function_exists('mb_strlen') ? mb_strlen($text) : strlen($text)) > 4000) {
    $text = function_exists('mb_substr') ? mb_substr($text, 0, 3990) . '…' : substr($text, 0, 3990) . '…';
}

$url = 'https://api.telegram.org/bot' . $token . '/sendMessage';
$post = http_build_query(
    [
        'chat_id' => $chatId,
        'text' => $text,
        'disable_web_page_preview' => '1',
    ],
    '',
    '&',
    PHP_QUERY_RFC3986
);

$ctx = stream_context_create([
    'http' => [
        'method' => 'POST',
        'header' => "Content-Type: application/x-www-form-urlencoded\r\n",
        'content' => $post,
        'timeout' => 15,
    ],
]);

$response = @file_get_contents($url, false, $ctx);
if ($response === false) {
    http_response_code(502);
    echo json_encode(['ok' => false, 'error' => 'telegram_send_failed'], JSON_UNESCAPED_UNICODE);
    exit;
}

$tg = json_decode($response, true);
if (!is_array($tg) || empty($tg['ok'])) {
    http_response_code(502);
    echo json_encode(['ok' => false, 'error' => 'telegram_send_failed'], JSON_UNESCAPED_UNICODE);
    exit;
}

$logFile = __DIR__ . DIRECTORY_SEPARATOR . 'telegram_leads.log';
$logLine = json_encode(
    [
        't' => gmdate('c'),
        'ip' => $ip,
        'name' => $name,
        'phone' => $phone,
        'context' => $context,
        'contact' => $contact,
        'comment' => $comment,
    ],
    JSON_UNESCAPED_UNICODE
);
if (is_string($logLine)) {
    @file_put_contents($logFile, $logLine . "\n", FILE_APPEND | LOCK_EX);
}

echo json_encode(['ok' => true], JSON_UNESCAPED_UNICODE);
