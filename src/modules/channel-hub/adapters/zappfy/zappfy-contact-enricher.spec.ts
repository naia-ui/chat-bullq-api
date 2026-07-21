import { Channel } from '@prisma/client';
import { ZappfyContactEnricherService } from './zappfy-contact-enricher.service';

const channel = { id: 'ch_1' } as unknown as Channel;
const EXTERNAL_ID = '5521999999999@s.whatsapp.net';

function build(contact: Record<string, any>) {
  const prisma: any = {
    contactChannel: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'cc_1',
        contactId: 'c_1',
        profileName: null,
        profileAvatarUrl: null,
        contact: { id: 'c_1', name: 'Fulano', avatarUrl: null, metadata: {}, ...contact },
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    contact: { update: jest.fn().mockResolvedValue({}) },
  };
  const httpClient: any = {
    sendRequest: jest.fn().mockResolvedValue({ chats: [{ wa_name: 'Fulano' }] }),
    fetchProfilePicture: jest.fn().mockResolvedValue({ url: null }),
    getMediaBuffer: jest.fn(),
  };
  const uploads: any = {
    avatarAgeInDays: (url: string | null) => (url ? 1 : null),
    saveAvatar: jest.fn(),
  };
  const realtime: any = { emitToOrg: jest.fn() };
  return {
    service: new ZappfyContactEnricherService(prisma, httpClient, uploads, realtime),
    realtime,
    prisma,
    httpClient,
  };
}

describe('ZappfyContactEnricherService — quantas vezes bate no provider', () => {
  it('não repergunta por quem não tem foto se já tentamos hoje', async () => {
    const { service, httpClient } = build({
      avatarUrl: null,
      metadata: { avatarCheckedAt: new Date().toISOString() },
    });

    await service.enrich(channel, EXTERNAL_ID);

    expect(httpClient.sendRequest).not.toHaveBeenCalled();
    expect(httpClient.fetchProfilePicture).not.toHaveBeenCalled();
  });

  it('tenta de novo quando a última tentativa foi ontem', async () => {
    const ontem = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const { service, httpClient } = build({
      avatarUrl: null,
      metadata: { avatarCheckedAt: ontem },
    });

    await service.enrich(channel, EXTERNAL_ID);

    expect(httpClient.fetchProfilePicture).toHaveBeenCalled();
  });

  it('carimba a tentativa preservando o resto do metadata', async () => {
    const { service, prisma } = build({
      avatarUrl: null,
      metadata: { hoppeId: 'abc' },
    });

    await service.enrich(channel, EXTERNAL_ID);

    const data = prisma.contact.update.mock.calls[0][0].data;
    expect(data.metadata.hoppeId).toBe('abc');
    expect(data.metadata.avatarCheckedAt).toBeTruthy();
  });

  it('quem já tem foto recente nem chega no provider', async () => {
    const { service, httpClient } = build({ avatarUrl: 'https://x/avatar.jpg' });

    await service.enrich(channel, EXTERNAL_ID);

    expect(httpClient.sendRequest).not.toHaveBeenCalled();
  });
});

describe('ZappfyContactEnricherService — foto nova chega na tela', () => {
  function buildWithPhoto(contact: Record<string, any>, downloadedUrl: string) {
    const prisma: any = {
      contactChannel: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'cc_1',
          contactId: 'c_1',
          profileName: 'Fulano',
          profileAvatarUrl: null,
          contact: {
            id: 'c_1',
            organizationId: 'org_1',
            name: 'Fulano',
            avatarUrl: null,
            metadata: {},
            ...contact,
          },
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      contact: { update: jest.fn().mockResolvedValue({}) },
    };
    const httpClient: any = {
      sendRequest: jest.fn().mockResolvedValue({ chats: [{ wa_name: 'Fulano' }] }),
      fetchProfilePicture: jest.fn().mockResolvedValue({ url: 'https://cdn/foto.jpg' }),
      getMediaBuffer: jest.fn().mockResolvedValue(Buffer.from('imagem')),
    };
    const uploads: any = {
      // Passou do prazo, então revalida.
      avatarAgeInDays: () => 30,
      saveAvatar: jest.fn().mockResolvedValue(downloadedUrl),
    };
    const realtime: any = { emitToOrg: jest.fn() };
    return {
      service: new ZappfyContactEnricherService(prisma, httpClient, uploads, realtime),
      realtime,
      prisma,
    };
  }

  it('grava e avisa por websocket quando a foto mudou', async () => {
    const { service, realtime, prisma } = buildWithPhoto(
      { avatarUrl: 'https://app/avatars/c_1.jpg?v=antiga' },
      'https://app/avatars/c_1.jpg?v=nova',
    );

    await service.enrich(channel, EXTERNAL_ID);

    const updates = prisma.contact.update.mock.calls.map((c: any[]) => c[0].data);
    expect(updates.some((d: any) => d.avatarUrl === 'https://app/avatars/c_1.jpg?v=nova')).toBe(true);
    expect(realtime.emitToOrg).toHaveBeenCalledWith('org_1', 'contact:avatar', {
      contactId: 'c_1',
      avatarUrl: 'https://app/avatars/c_1.jpg?v=nova',
      name: 'Fulano',
    });
  });

  it('mesma foto não vira evento — a URL é versionada pelo conteúdo', async () => {
    const mesma = 'https://app/avatars/c_1.jpg?v=igual';
    const { service, realtime } = buildWithPhoto({ avatarUrl: mesma }, mesma);

    await service.enrich(channel, EXTERNAL_ID);

    expect(realtime.emitToOrg).not.toHaveBeenCalled();
  });
});
