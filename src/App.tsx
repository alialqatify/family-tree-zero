import { useEffect, useState } from 'react';
import Dashboard from '@/Dashboard';
import FamilyTree from '@/FamilyTree';

function App() {
  const [route, setRoute] = useState(window.location.hash);

  useEffect(() => {
    const onHashChange = () => setRoute(window.location.hash);
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  if (route === '#/tree') {
    return <FamilyTree />;
  }
  return <Dashboard />;
}

export default App;
