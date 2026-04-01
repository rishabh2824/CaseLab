import { Navigate, Route, Routes } from 'react-router-dom'
import Case from './case.jsx'
import Home from './pages/Home.jsx'
import StudentHome from './pages/StudentHome.jsx'

function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/admin" element={<Case />} />
      <Route path="/student" element={<StudentHome />} />
      <Route path="/newCase" element={<Navigate to="/admin" replace />} />
    </Routes>
  )
}

export default App
