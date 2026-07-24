import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);
    this.setState({ error, errorInfo });
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '20px', fontFamily: 'sans-serif', color: 'black', background: 'white', minHeight: '100vh' }}>
          <h1 style={{ color: 'red' }}>Something went wrong.</h1>
          <h3>{this.state.error?.message}</h3>
          <details style={{ whiteSpace: 'pre-wrap', marginTop: '20px', background: '#f5f5f5', padding: '10px' }}>
            <summary>Stack Trace</summary>
            {this.state.errorInfo?.componentStack}
            {'\n'}
            {this.state.error?.stack}
          </details>
        </div>
      );
    }

    return this.props.children;
  }
}
