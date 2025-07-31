// This page will be rendered when an error makes it all the way to the top of the
// application without being handled by a Javascript catch statement or React error
// boundary.

interface FatalErrorPageProps {
  error?: Error;
}

export default function FatalErrorPage({ error }: FatalErrorPageProps) {
  return (
    <main>
      <style
        dangerouslySetInnerHTML={{
          __html: `
              html, body {
                margin: 0;
              }
              html * {
                box-sizing: border-box;
              }
              main {
                display: flex;
                align-items: center;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif;
                text-align: center;
                background-color: #E2E8F0;
                height: 100vh;
              }
              section {
                background-color: white;
                border-radius: 0.25rem;
                width: 32rem;
                padding: 1rem;
                margin: 0 auto;
                box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06);
              }
              h1 {
                font-size: 2rem;
                margin: 0;
                font-weight: 500;
                line-height: 1;
                color: #2D3748;
              }
              .error-details {
                margin-top: 1rem;
                font-family: monospace;
                font-size: 0.875rem;
                color: #718096;
                text-align: left;
                background: #F7FAFC;
                padding: 1rem;
                border-radius: 0.25rem;
                overflow-x: auto;
              }
            `,
        }}
      />
      <section>
        <h1>
          <span>Something went wrong</span>
        </h1>
        {error && process.env.NODE_ENV === 'development' && (
          <div className="error-details">
            <h3>Error Details (Development Mode)</h3>
            <p><strong>Message:</strong> {error.message}</p>
            {error.stack && (
              <pre>{error.stack}</pre>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
