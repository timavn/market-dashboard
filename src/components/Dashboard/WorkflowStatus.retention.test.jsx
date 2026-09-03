import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import axios from 'axios';
import WorkflowStatus from './WorkflowStatus';
import PersistentSurface from '../common/PersistentSurface';
import { resetSessionResourceStore } from '../../utils/sessionResourceStore';

jest.mock('axios', () => ({
  get: jest.fn(),
  create: jest.fn(() => ({
    get: jest.fn(),
    post: jest.fn(),
    interceptors: { response: { use: jest.fn() } },
  })),
}));

const brief = () => ({
  events: [],
  generatedAt: new Date().toISOString(),
  summary: { current: 0, issues: 0 },
  sourceHealth: [],
});

describe('WorkflowStatus session retention', () => {
  beforeEach(() => {
    resetSessionResourceStore();
    window.sessionStorage.clear();
    axios.get.mockResolvedValue({ data: brief(), headers: {} });
  });

  afterEach(() => {
    resetSessionResourceStore();
    window.sessionStorage.clear();
    jest.clearAllMocks();
  });

  test('reopens without an activation request and defers an explicit hidden refresh', async () => {
    const view = render(
      <PersistentSurface active>
        <WorkflowStatus refreshToken={0} />
      </PersistentSurface>,
    );
    await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });

    view.rerender(
      <PersistentSurface active={false}>
        <WorkflowStatus refreshToken={1} />
      </PersistentSurface>,
    );
    await act(async () => { await Promise.resolve(); });
    expect(axios.get).toHaveBeenCalledTimes(1);

    view.rerender(
      <PersistentSurface active>
        <WorkflowStatus refreshToken={1} />
      </PersistentSurface>,
    );
    await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(2));
    expect(axios.get.mock.calls[1][0]).toMatch(/\/api\/analytics\/daily-brief\?refresh=1$/);

    view.rerender(
      <PersistentSurface active={false}>
        <WorkflowStatus refreshToken={1} />
      </PersistentSurface>,
    );
    view.rerender(
      <PersistentSurface active>
        <WorkflowStatus refreshToken={1} />
      </PersistentSurface>,
    );
    await act(async () => { await Promise.resolve(); });
    expect(axios.get).toHaveBeenCalledTimes(2);
  });
});
