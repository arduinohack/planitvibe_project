import 'package:flutter_test/flutter_test.dart';
import 'package:planitvibe_frontend/utils/attachment_cache.dart';

void main() {
  test('a viewed file is named from the attachment id and type', () {
    expect(
      attachmentCacheRelativePath(
        attachmentId: '391d49b3-edbd-4c74-9e1a-b39ea4597189',
        mimeType: 'image/jpeg',
        filename: 'photo.png',
      ),
      'attachments/391d49b3-edbd-4c74-9e1a-b39ea4597189.jpg',
    );
    expect(
      attachmentCacheRelativePath(
        attachmentId: 'file-1',
        mimeType: 'application/pdf',
        filename: 'ticket.txt',
      ),
      'attachments/file-1.pdf',
    );
    expect(
      attachmentCacheRelativePath(
        attachmentId: 'file-2',
        mimeType: '',
        filename: 'scan.HEIC',
      ),
      'attachments/file-2.heic',
    );
  });

  test('the cache path stays inside the documents directory', () {
    expect(
      attachmentCacheFullPath(
        documentsDir: '/data/user/0/app/app_flutter',
        attachmentId: '../secret',
        mimeType: 'image/png',
        filename: 'x.png',
      ),
      '/data/user/0/app/app_flutter/attachments/secret.png',
    );
    expect(
      attachmentCacheFullPath(
        documentsDir: r'C:\docs',
        attachmentId: 'file-1',
        mimeType: 'application/pdf',
        filename: 'ticket.pdf',
        separator: r'\',
      ),
      r'C:\docs\attachments\file-1.pdf',
    );
    expect(
      attachmentCacheFullPath(
        documentsDir: '   ',
        attachmentId: 'file-1',
        mimeType: 'image/png',
        filename: 'x.png',
      ),
      isNull,
    );
  });

  test('the local map stores, drops, and ignores a bad record', () {
    const empty = AttachmentCacheIndex();
    final saved = empty.withPath('file-1', '/docs/attachments/file-1.jpg');
    expect(saved.pathFor('file-1'), '/docs/attachments/file-1.jpg');
    expect(saved.without('file-1').pathFor('file-1'), isNull);

    final decoded = AttachmentCacheIndex.decode(saved.encode());
    expect(decoded.pathFor('file-1'), '/docs/attachments/file-1.jpg');
    expect(
      AttachmentCacheIndex.decode('{"file-2":"  "," ": "/tmp/x"}').paths,
      isEmpty,
    );
    expect(
      () => AttachmentCacheIndex.decode('not-json'),
      throwsFormatException,
    );
  });

  test('only Android and iOS keep a cache', () {
    expect(attachmentCacheEnabled(web: false, platform: 'android'), isTrue);
    expect(attachmentCacheEnabled(web: false, platform: 'iOS'), isTrue);
    expect(attachmentCacheEnabled(web: true, platform: 'android'), isFalse);
    expect(attachmentCacheEnabled(web: false, platform: 'windows'), isFalse);
    expect(attachmentCacheEnabled(web: false, platform: 'macOS'), isFalse);
  });
}
