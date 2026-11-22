import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

const _partSize = 5 * 1024 * 1024;
const _json = {'Content-Type': 'application/json'};

class UploadException implements Exception {
  const UploadException(this.status, this.code, this.retryAfter);

  final int status;
  final String code;
  final String? retryAfter;

  @override
  String toString() => 'UploadException($status, $code)';
}

class UploadSession {
  UploadSession(this.uploadId, this.key, Map<int, String> parts)
    : parts = Map.unmodifiable(parts);

  final String uploadId;
  final String key;
  final Map<int, String> parts;
}

class UploadClient {
  UploadClient(this.baseUri, this.accessToken, this.httpClient);

  final Uri baseUri;
  final Future<String> Function() accessToken;
  final http.Client httpClient;

  Future<Map<String, dynamic>> _send(http.BaseRequest request) async {
    request.headers['Authorization'] = 'Bearer ${await accessToken()}';
    final response = await http.Response.fromStream(
      await httpClient.send(request),
    );
    Object? decoded;
    try {
      decoded = jsonDecode(response.body);
    } on FormatException {
      decoded = null;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      final code = decoded is Map ? decoded['error'] : null;
      throw UploadException(
        response.statusCode,
        code is String ? code : 'UPLOAD_FAILED',
        response.headers['retry-after'],
      );
    }
    if (decoded is! Map<String, dynamic>) {
      throw const FormatException('Expected an upload response object');
    }
    return decoded;
  }

  Future<Map<String, dynamic>> _post(String path, Map<String, Object> body) {
    final request = http.Request('POST', baseUri.resolve(path))
      ..headers.addAll(_json)
      ..body = jsonEncode(body);
    return _send(request);
  }

  Future<Map<String, dynamic>> upload(
    Uint8List bytes, {
    required String filename,
    String contentType = 'application/octet-stream',
    UploadSession? session,
    void Function(UploadSession)? onCheckpoint,
  }) async {
    if (bytes.isEmpty || bytes.length > 20 * _partSize) {
      throw RangeError('File must be between 1 byte and 100 MiB');
    }
    if (bytes.length <= _partSize && session == null) {
      final request =
          http.MultipartRequest('POST', baseUri.resolve('/upload/single'))
            ..files.add(
              http.MultipartFile.fromBytes(
                'file',
                bytes,
                filename: filename,
                contentType: http.MediaType.parse(contentType),
              ),
            );
      return _send(request);
    }
    final ticket =
        session ?? await _create(filename, contentType, bytes.length);
    final uploadId = ticket.uploadId;
    final key = ticket.key;
    final parts = {...ticket.parts};
    onCheckpoint?.call(UploadSession(uploadId, key, parts));
    for (var offset = 0; offset < bytes.length; offset += _partSize) {
      final partNumber = offset ~/ _partSize + 1;
      if (parts.containsKey(partNumber)) continue;
      final end = (offset + _partSize).clamp(0, bytes.length);
      final uri = baseUri
          .resolve('/upload/multipart/upload-part')
          .replace(
            queryParameters: {
              'uploadId': uploadId,
              'key': key,
              'partNumber': '$partNumber',
            },
          );
      final request = http.Request('PUT', uri)
        ..headers['Content-Type'] = 'application/octet-stream'
        ..bodyBytes = Uint8List.sublistView(bytes, offset, end);
      final response = await _send(request);
      parts[partNumber] = response['etag'] as String;
      onCheckpoint?.call(UploadSession(uploadId, key, parts));
    }
    return _post('/upload/multipart/complete', {
      'uploadId': uploadId,
      'key': key,
      'parts': [
        for (final part in parts.entries)
          {'partNumber': part.key, 'etag': part.value},
      ],
    });
  }

  Future<UploadSession> _create(
    String filename,
    String contentType,
    int size,
  ) async {
    final response = await _post('/upload/multipart/create', {
      'filename': filename,
      'contentType': contentType,
      'size': size,
    });
    return UploadSession(
      response['uploadId'] as String,
      response['key'] as String,
      {},
    );
  }

  Future<void> abort(UploadSession session) async {
    await _post('/upload/multipart/abort', {
      'uploadId': session.uploadId,
      'key': session.key,
    });
  }
}
